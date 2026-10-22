/**
 * RangeSourceUpstreams.mm
 * Where a reader's bytes come from: a URL read with URLSession, or an app's RangeDataSource.
 */

#import "RangeSourceInternal.h"

#include <algorithm>
#include <condition_variable>
#include <cstring>
#include <functional>
#include <mutex>
#include <string>

namespace {

/**
 * Bytes handed from callbacks on any thread to the reader's fetch thread: a response, then data,
 * then the end or an error. With flow control, the producer is paused while more than kHighBytes
 * wait and resumed under kLowBytes.
 */
class Pipe {
public:
    static constexpr size_t kHighBytes = 1024 * 1024;
    static constexpr size_t kLowBytes = 256 * 1024;

    /** Called under the pipe's lock with true to pause the producer, false to resume it. */
    void setFlowControl(std::function<void(bool)> pause) {
        std::lock_guard<std::mutex> lock(mutex_);
        pause_ = std::move(pause);
    }

    /** `skip`: bytes of the data to drop first, for a server that answered from 0. */
    void respond(const rs_objc::SourceInfo& info, int64_t skip = 0) {
        std::lock_guard<std::mutex> lock(mutex_);
        if (responded_ || done_) return;
        responded_ = true;
        info_ = info;
        skip_ = skip;
        changed_.notify_all();
    }

    void push(const uint8_t* data, size_t size) {
        std::lock_guard<std::mutex> lock(mutex_);
        if (done_ || !responded_) return;
        if (skip_ > 0) {
            size_t dropped = static_cast<size_t>(std::min<int64_t>(skip_, static_cast<int64_t>(size)));
            skip_ -= static_cast<int64_t>(dropped);
            data += dropped;
            size -= dropped;
        }
        if (size == 0) return;
        buffer_.append(reinterpret_cast<const char*>(data), size);
        if (pause_ && !paused_ && bufferedLocked() > kHighBytes) {
            paused_ = true;
            pause_(true);
        }
        changed_.notify_all();
    }

    /** An empty error is the end of the data. Only the first call counts. */
    void finish(const std::string& error) {
        std::lock_guard<std::mutex> lock(mutex_);
        if (done_) return;
        done_ = true;
        error_ = error;
        changed_.notify_all();
    }

    void cancel() { finish("Cancelled"); }

    bool waitResponse(rs_objc::SourceInfo& info, std::string& error) {
        std::unique_lock<std::mutex> lock(mutex_);
        changed_.wait(lock, [&] { return responded_ || done_; });
        if (!responded_) {
            error = error_.empty() ? "The source ended without a response" : error_;
            return false;
        }
        info = info_;
        return true;
    }

    /** Bytes read, 0 at the end, or -1 with `error` set; the data before an error comes first. */
    int64_t read(uint8_t* out, int64_t size, std::string& error) {
        std::unique_lock<std::mutex> lock(mutex_);
        changed_.wait(lock, [&] { return bufferedLocked() > 0 || done_; });
        size_t available = bufferedLocked();
        if (available > 0) {
            size_t n = std::min(available, static_cast<size_t>(size));
            memcpy(out, buffer_.data() + offset_, n);
            offset_ += n;
            if (offset_ == buffer_.size()) {
                buffer_.clear();
                offset_ = 0;
            } else if (offset_ > kHighBytes) {
                buffer_.erase(0, offset_);
                offset_ = 0;
            }
            if (paused_ && bufferedLocked() < kLowBytes) {
                paused_ = false;
                pause_(false);
            }
            return static_cast<int64_t>(n);
        }
        if (!error_.empty()) {
            error = error_;
            return -1;
        }
        return 0;
    }

private:
    size_t bufferedLocked() const { return buffer_.size() - offset_; }

    std::mutex mutex_;
    std::condition_variable changed_;
    std::function<void(bool)> pause_;
    bool paused_ = false;
    bool responded_ = false;
    bool done_ = false;
    rs_objc::SourceInfo info_;
    int64_t skip_ = 0;
    std::string buffer_;
    size_t offset_ = 0;
    std::string error_;
};

std::string stdString(NSString* text) {
    return text ? std::string(text.UTF8String) : std::string();
}

std::string describe(NSError* error) {
    return stdString(error.localizedDescription ?: @"The read failed");
}

} // namespace

#pragma mark - URLSession

/** One task's pipe, and where its read starts. */
@interface RangeSourceTaskState : NSObject {
@public
    std::shared_ptr<Pipe> pipe;
    int64_t position;
}
@end

@implementation RangeSourceTaskState
@end

/** Routes a session's task callbacks to each task's pipe. Callbacks run on the session's queue. */
@interface RangeSourceSessionDelegate : NSObject <NSURLSessionDataDelegate>
- (void)track:(NSURLSessionTask *)task state:(RangeSourceTaskState *)state;
@end

@implementation RangeSourceSessionDelegate {
    // @synchronized (self)
    NSMutableDictionary<NSNumber *, RangeSourceTaskState *> *_tasks;
}

- (instancetype)init {
    if ((self = [super init])) _tasks = [NSMutableDictionary dictionary];
    return self;
}

- (void)track:(NSURLSessionTask *)task state:(RangeSourceTaskState *)state {
    @synchronized (self) {
        _tasks[@(task.taskIdentifier)] = state;
    }
}

- (nullable RangeSourceTaskState *)stateOf:(NSURLSessionTask *)task remove:(BOOL)remove {
    @synchronized (self) {
        RangeSourceTaskState *state = _tasks[@(task.taskIdentifier)];
        if (remove) [_tasks removeObjectForKey:@(task.taskIdentifier)];
        return state;
    }
}

static int64_t RangeSourceTotalFromContentRange(NSString *contentRange, int64_t *start) {
    // "bytes 100-199/1000", "bytes 100-199/*" or, answering 416, "bytes */1000"
    NSScanner *scanner = [NSScanner scannerWithString:contentRange ?: @""];
    long long first = -1, total = -1;
    if (![scanner scanString:@"bytes" intoString:nil]) return -1;
    if (![scanner scanString:@"*" intoString:nil]) {
        if (![scanner scanLongLong:&first]) return -1;
        [scanner scanUpToString:@"/" intoString:nil];
    }
    if (start) *start = first;
    if (![scanner scanString:@"/" intoString:nil] || ![scanner scanLongLong:&total]) return -1;
    return total;
}

- (void)URLSession:(NSURLSession *)session
          dataTask:(NSURLSessionDataTask *)dataTask
didReceiveResponse:(NSURLResponse *)response
 completionHandler:(void (^)(NSURLSessionResponseDisposition))completionHandler {
    RangeSourceTaskState *state = [self stateOf:dataTask remove:NO];
    if (!state) {
        completionHandler(NSURLSessionResponseCancel);
        return;
    }
    NSHTTPURLResponse *http = [response isKindOfClass:[NSHTTPURLResponse class]] ? (NSHTTPURLResponse *)response : nil;
    rs_objc::SourceInfo info;
    info.etag = stdString([http valueForHTTPHeaderField:@"ETag"]);
    info.lastModified = stdString([http valueForHTTPHeaderField:@"Last-Modified"]);
    NSString *encoding = [http valueForHTTPHeaderField:@"Content-Encoding"];
    if (encoding.length > 0 && [encoding caseInsensitiveCompare:@"identity"] != NSOrderedSame) {
        // URLSession decodes it, and the offsets would be into the decoded bytes
        state->pipe->finish(stdString([NSString stringWithFormat:@"%@ came compressed (%@)", response.URL, encoding]));
        completionHandler(NSURLSessionResponseCancel);
        return;
    }
    NSInteger status = http ? http.statusCode : 200;
    NSString *contentRange = [http valueForHTTPHeaderField:@"Content-Range"];
    if (status == 206) {
        int64_t start = -1;
        info.size = RangeSourceTotalFromContentRange(contentRange, &start);
        if (start != state->position) {
            state->pipe->finish(stdString([NSString stringWithFormat:@"Asked %@ for bytes from %lld and got %@",
                                           response.URL, (long long)state->position, contentRange]));
            completionHandler(NSURLSessionResponseCancel);
            return;
        }
        state->pipe->respond(info);
    } else if (status == 200) {
        // No ranges: the whole file, read past the bytes before the position
        info.size = response.expectedContentLength >= 0 ? response.expectedContentLength : -1;
        state->pipe->respond(info, state->position);
    } else if (status == 416) {
        // At or past the end: a read that ends at once
        info.size = RangeSourceTotalFromContentRange(contentRange, nullptr);
        state->pipe->respond(info);
        state->pipe->finish("");
        completionHandler(NSURLSessionResponseCancel);
        return;
    } else {
        state->pipe->finish(stdString([NSString stringWithFormat:@"HTTP %ld for %@", (long)status, response.URL]));
        completionHandler(NSURLSessionResponseCancel);
        return;
    }
    completionHandler(NSURLSessionResponseAllow);
}

- (void)URLSession:(NSURLSession *)session dataTask:(NSURLSessionDataTask *)dataTask didReceiveData:(NSData *)data {
    RangeSourceTaskState *state = [self stateOf:dataTask remove:NO];
    if (!state) return;
    [data enumerateByteRangesUsingBlock:^(const void *bytes, NSRange range, BOOL *stop) {
        state->pipe->push(static_cast<const uint8_t *>(bytes), range.length);
    }];
}

- (void)URLSession:(NSURLSession *)session task:(NSURLSessionTask *)task didCompleteWithError:(NSError *)error {
    RangeSourceTaskState *state = [self stateOf:task remove:YES];
    if (!state) return;
    state->pipe->finish(error ? describe(error) : "");
}

@end

namespace {

/** Suspended while the reader has a megabyte waiting. */
class URLSessionUpstream : public rs_objc::Upstream {
public:
    URLSessionUpstream(NSURL* url, NSDictionary<NSString*, NSString*>* headers)
        : url_(url), headers_([headers copy]), delegate_([RangeSourceSessionDelegate new]) {
        NSURLSessionConfiguration* configuration = [NSURLSessionConfiguration defaultSessionConfiguration];
        // The reader's store is the cache
        configuration.URLCache = nil;
        configuration.requestCachePolicy = NSURLRequestReloadIgnoringLocalCacheData;
        configuration.timeoutIntervalForRequest = 30;
        session_ = [NSURLSession sessionWithConfiguration:configuration delegate:delegate_ delegateQueue:nil];
    }

    ~URLSessionUpstream() override {
        close();
        // The session holds its delegate until invalidated
        [session_ invalidateAndCancel];
    }

    bool open(int64_t position, rs_objc::SourceInfo& info, std::string& error) override {
        close();
        NSMutableURLRequest* request = [NSMutableURLRequest requestWithURL:url_];
        [headers_ enumerateKeysAndObjectsUsingBlock:^(NSString* name, NSString* value, BOOL* stop) {
            [request setValue:value forHTTPHeaderField:name];
        }];
        // Offsets are into the file as stored, so no transparent gzip
        [request setValue:@"identity" forHTTPHeaderField:@"Accept-Encoding"];
        [request setValue:[NSString stringWithFormat:@"bytes=%lld-", (long long)position] forHTTPHeaderField:@"Range"];
        NSURLSessionDataTask* task = [session_ dataTaskWithRequest:request];

        auto pipe = std::make_shared<Pipe>();
        pipe->setFlowControl([task](bool pause) {
            if (pause) [task suspend];
            else [task resume];
        });
        {
            std::lock_guard<std::mutex> lock(mutex_);
            if (cancelled_) {
                error = "Cancelled";
                return false;
            }
            task_ = task;
            pipe_ = pipe;
        }
        RangeSourceTaskState* state = [RangeSourceTaskState new];
        state->pipe = pipe;
        state->position = position;
        [delegate_ track:task state:state];
        [task resume];
        return pipe->waitResponse(info, error);
    }

    int64_t read(uint8_t* out, int64_t size, std::string& error) override {
        std::shared_ptr<Pipe> pipe = currentPipe();
        if (!pipe) {
            error = "Not open";
            return -1;
        }
        return pipe->read(out, size, error);
    }

    void close() override {
        NSURLSessionDataTask* task;
        std::shared_ptr<Pipe> pipe;
        {
            std::lock_guard<std::mutex> lock(mutex_);
            task = task_;
            pipe = std::move(pipe_);
            task_ = nil;
        }
        if (pipe) pipe->cancel();
        [task cancel];
    }

    void cancel() override {
        {
            std::lock_guard<std::mutex> lock(mutex_);
            cancelled_ = true;
        }
        close();
    }

private:
    std::shared_ptr<Pipe> currentPipe() {
        std::lock_guard<std::mutex> lock(mutex_);
        return pipe_;
    }

    NSURL* const url_;
    NSDictionary<NSString*, NSString*>* const headers_;
    RangeSourceSessionDelegate* const delegate_;
    NSURLSession* session_;
    std::mutex mutex_;
    NSURLSessionDataTask* task_ = nil;
    std::shared_ptr<Pipe> pipe_;
    bool cancelled_ = false;
};

/**
 * Reads through an app's RangeDataSource in windows of kWindowBytes, asking for the next window
 * when one ends, so that a source never has more than one window to hold.
 */
class DataSourceUpstream : public rs_objc::Upstream {
public:
    static constexpr int64_t kWindowBytes = 4 * 1024 * 1024;

    DataSourceUpstream(id<RangeDataSource> source, NSURL* url, NSDictionary<NSString*, NSString*>* headers)
        : source_(source), url_(url), headers_([headers copy]) {}

    ~DataSourceUpstream() override { close(); }

    bool open(int64_t position, rs_objc::SourceInfo& info, std::string& error) override {
        close();
        position_ = position;
        size_ = -1;
        return startWindow(&info, error);
    }

    int64_t read(uint8_t* out, int64_t size, std::string& error) override {
        for (;;) {
            std::shared_ptr<Pipe> pipe = currentPipe();
            if (!pipe) {
                error = "Not open";
                return -1;
            }
            int64_t n = pipe->read(out, size, error);
            if (n > 0) position_ += n;
            if (n != 0) return n;
            // A window shorter than asked for ends at the end of the file
            if (position_ < windowEnd_ || (size_ >= 0 && position_ >= size_)) return 0;
            if (!startWindow(nullptr, error)) return -1;
        }
    }

    void close() override {
        id<RangeCancellable> token;
        std::shared_ptr<Pipe> pipe;
        {
            std::lock_guard<std::mutex> lock(mutex_);
            token = token_;
            pipe = std::move(pipe_);
            token_ = nil;
        }
        if (pipe) pipe->cancel();
        [token cancel];
    }

    void cancel() override {
        {
            std::lock_guard<std::mutex> lock(mutex_);
            cancelled_ = true;
        }
        close();
    }

private:
    bool startWindow(rs_objc::SourceInfo* info, std::string& error) {
        auto pipe = std::make_shared<Pipe>();
        {
            std::lock_guard<std::mutex> lock(mutex_);
            if (cancelled_) {
                error = "Cancelled";
                return false;
            }
            pipe_ = pipe;
        }
        windowEnd_ = position_ + kWindowBytes;
        id<RangeCancellable> token = [source_ readURL:url_
                                               offset:position_
                                               length:kWindowBytes
                                              headers:headers_ ?: @{}
                                             response:^(RangeDataInfo* dataInfo) {
            rs_objc::SourceInfo sourceInfo;
            sourceInfo.size = dataInfo.size >= 0 ? dataInfo.size : -1;
            sourceInfo.etag = stdString(dataInfo.etag);
            sourceInfo.lastModified = stdString(dataInfo.lastModified);
            pipe->respond(sourceInfo);
        }
                                                 data:^(NSData* data) {
            [data enumerateByteRangesUsingBlock:^(const void* bytes, NSRange range, BOOL* stop) {
                pipe->push(static_cast<const uint8_t*>(bytes), range.length);
            }];
        }
                                           completion:^(NSError* _Nullable readError) {
            pipe->finish(readError ? describe(readError) : "");
        }];
        bool cancelNow;
        {
            std::lock_guard<std::mutex> lock(mutex_);
            token_ = token;
            cancelNow = cancelled_;
        }
        if (cancelNow) [token cancel];

        rs_objc::SourceInfo got;
        if (!pipe->waitResponse(got, error)) return false;
        if (got.size >= 0) size_ = got.size;
        if (info) *info = got;
        return true;
    }

    std::shared_ptr<Pipe> currentPipe() {
        std::lock_guard<std::mutex> lock(mutex_);
        return pipe_;
    }

    const id<RangeDataSource> source_;
    NSURL* const url_;
    NSDictionary<NSString*, NSString*>* const headers_;
    // The fetch thread's
    int64_t position_ = 0;
    int64_t windowEnd_ = 0;
    int64_t size_ = -1;
    // Also read by cancel(), from any thread
    std::mutex mutex_;
    std::shared_ptr<Pipe> pipe_;
    id<RangeCancellable> token_ = nil;
    bool cancelled_ = false;
};

} // namespace

std::unique_ptr<rs_objc::Upstream> RangeSourceURLSessionUpstream(NSURL *url, NSDictionary<NSString *, NSString *> *headers) {
    return std::make_unique<URLSessionUpstream>(url, headers);
}

std::unique_ptr<rs_objc::Upstream> RangeSourceDataSourceUpstream(id<RangeDataSource> dataSource, NSURL *url,
                                                                 NSDictionary<NSString *, NSString *> *headers) {
    return std::make_unique<DataSourceUpstream>(dataSource, url, headers);
}
