/**
 * RangeSource.mm
 * The Objective-C API, over the add-on's own C table as the players use it.
 */

#import "RangeSourceInternal.h"

#include <string>

NSErrorDomain const RangeSourceErrorDomain = @"RangeSourceErrorDomain";

static std::string RangeSourceStdString(NSString *text) {
    return text ? std::string(text.UTF8String) : std::string();
}

static NSString *RangeSourceNSString(const std::string &text) {
    return [NSString stringWithUTF8String:text.c_str()] ?: @"";
}

static NSError *RangeSourceError(NSString *message) {
    return [NSError errorWithDomain:RangeSourceErrorDomain
                               code:1
                           userInfo:@{NSLocalizedDescriptionKey: message.length > 0 ? message : @"The read failed"}];
}

#pragma mark - Data sources

@implementation RangeDataInfo

- (instancetype)initWithSize:(int64_t)size etag:(NSString *)etag lastModified:(NSString *)lastModified {
    if ((self = [super init])) {
        _size = size >= 0 ? size : -1;
        _etag = [etag copy];
        _lastModified = [lastModified copy];
    }
    return self;
}

@end

@implementation RangeDataSources

static NSMutableDictionary<NSString *, id<RangeDataSource>> *RangeSourceRegisteredSources(void) {
    static NSMutableDictionary<NSString *, id<RangeDataSource>> *sources;
    static dispatch_once_t once;
    dispatch_once(&once, ^{
        sources = [NSMutableDictionary dictionary];
    });
    return sources;
}

+ (void)registerDataSource:(id<RangeDataSource>)dataSource name:(NSString *)name {
    @synchronized (self) {
        RangeSourceRegisteredSources()[name] = dataSource;
    }
}

+ (void)unregisterName:(NSString *)name {
    @synchronized (self) {
        [RangeSourceRegisteredSources() removeObjectForKey:name];
    }
}

+ (id<RangeDataSource>)dataSourceNamed:(NSString *)name {
    @synchronized (self) {
        return RangeSourceRegisteredSources()[name];
    }
}

@end

#pragma mark - Stores

@implementation RangeSourceStore {
@public
    std::shared_ptr<rs_objc::Store> _store;
}

- (instancetype)initWithStore:(std::shared_ptr<rs_objc::Store>)store {
    if ((self = [super init])) _store = std::move(store);
    return self;
}

+ (instancetype)diskStoreAtPath:(NSString *)path maxBytes:(int64_t)maxBytes error:(NSError **)error {
    auto store = rs_objc::Store::disk(range_source_plugin(), RangeSourceStdString(path), maxBytes);
    if (!store) {
        if (error) *error = RangeSourceError([NSString stringWithFormat:@"Can't create a store in %@", path]);
        return nil;
    }
    return [[self alloc] initWithStore:std::move(store)];
}

+ (instancetype)memoryStoreNamed:(NSString *)name maxBytes:(int64_t)maxBytes {
    return [[self alloc] initWithStore:rs_objc::Store::memory(range_source_plugin(), RangeSourceStdString(name), maxBytes)];
}

- (int64_t)bytesUsed {
    return _store->bytesUsed();
}

- (void)setMaxBytes:(int64_t)maxBytes {
    _store->setMaxBytes(maxBytes);
}

- (RangeSourceHolds)holdsKey:(NSString *)key {
    return static_cast<RangeSourceHolds>(_store->holds(RangeSourceStdString(key)));
}

- (void)removeKey:(NSString *)key {
    _store->remove(RangeSourceStdString(key));
}

- (void)clear {
    _store->clear();
}

@end

#pragma mark - Readers

@implementation RangeSourceReaderOptions

- (instancetype)init {
    if ((self = [super init])) {
        _headers = @{};
        _blockSize = -1;
        _memoryBytes = -1;
        _readAheadBytes = -1;
        _reconnectGap = -1;
        _retries = -1;
        _retryDelayMs = -1;
    }
    return self;
}

@end

@implementation RangeSourceStats

- (instancetype)initWithStats:(const rs_objc::RangeReader::Stats &)stats {
    if ((self = [super init])) {
        _opens = stats.opens;
        _bytesFetched = stats.bytesFetched;
    }
    return self;
}

@end

@implementation RangeSourceReader {
    std::shared_ptr<rs_objc::RangeReader> _reader;
}

+ (instancetype)openURL:(NSURL *)url
             dataSource:(id<RangeDataSource>)dataSource
                  store:(RangeSourceStore *)store
                    key:(NSString *)key
                options:(RangeSourceReaderOptions *)options
                  error:(NSError **)error {
    options = options ?: [RangeSourceReaderOptions new];
    std::unique_ptr<rs_objc::Upstream> upstream = dataSource
        ? RangeSourceDataSourceUpstream(dataSource, url, options.headers)
        : RangeSourceURLSessionUpstream(url, options.headers);
    rs_objc::ReaderOptions readerOptions;
    readerOptions.blockSize = options.blockSize;
    readerOptions.memoryBytes = options.memoryBytes;
    readerOptions.readAheadBytes = options.readAheadBytes;
    readerOptions.reconnectGap = options.reconnectGap;
    readerOptions.retries = options.retries;
    readerOptions.retryDelayMs = options.retryDelayMs;
    std::string openError;
    auto reader = rs_objc::RangeReader::open(range_source_plugin(), std::move(upstream), store ? store->_store : nullptr,
                                             RangeSourceStdString(key ?: url.absoluteString), readerOptions, openError);
    if (!reader) {
        if (error) *error = RangeSourceError(RangeSourceNSString(openError));
        return nil;
    }
    RangeSourceReader *result = [[self alloc] initPrivate];
    result->_reader = std::move(reader);
    return result;
}

- (instancetype)initPrivate {
    return [super init];
}

- (int64_t)size {
    return _reader->size();
}

- (NSInteger)readAt:(int64_t)position into:(void *)buffer length:(NSInteger)length {
    return static_cast<NSInteger>(_reader->read(position, static_cast<uint8_t *>(buffer), length));
}

- (NSData *)readDataAt:(int64_t)position length:(NSInteger)length error:(NSError **)error {
    NSMutableData *data = [NSMutableData dataWithLength:static_cast<NSUInteger>(MAX(length, 0))];
    NSInteger n = [self readAt:position into:data.mutableBytes length:length];
    if (n < 0) {
        if (error) *error = RangeSourceError(self.lastError);
        return nil;
    }
    data.length = static_cast<NSUInteger>(n);
    return data;
}

- (NSInteger)tryReadAt:(int64_t)position into:(void *)buffer length:(NSInteger)length {
    return static_cast<NSInteger>(_reader->tryRead(position, static_cast<uint8_t *>(buffer), length));
}

- (BOOL)fetchAll:(NSError **)error {
    if (_reader->fetchAll()) return YES;
    if (error) *error = RangeSourceError(self.lastError);
    return NO;
}

- (NSString *)lastError {
    return RangeSourceNSString(_reader->lastError());
}

- (RangeSourceStats *)stats {
    return [[RangeSourceStats alloc] initWithStats:_reader->stats()];
}

- (void)close {
    _reader->close();
}

@end

#pragma mark - The add-on

@implementation RangeSource

+ (NSString *)versionString {
    return [NSString stringWithUTF8String:range_source_plugin()->version];
}

+ (RangeSourceReader *)openURL:(NSURL *)url store:(RangeSourceStore *)store error:(NSError **)error {
    return [RangeSourceReader openURL:url dataSource:nil store:store key:nil options:nil error:error];
}

+ (const void *)plugin {
    return range_source_plugin();
}

+ (BOOL)getUpstream:(void *)upstream
    forDataSourceNamed:(NSString *)name
                   URL:(NSURL *)url
               headers:(NSDictionary<NSString *, NSString *> *)headers {
    id<RangeDataSource> dataSource = [RangeDataSources dataSourceNamed:name];
    if (!dataSource) return NO;
    *static_cast<RangeSourceUpstream *>(upstream) =
        rs_objc::Upstream::toC(RangeSourceDataSourceUpstream(dataSource, url, headers));
    return YES;
}

@end
