// Host tests for the native range reader and stores, built twice: on the C++ classes
// (range_source_tests), and through the C table in range_source.h (range_source_abi_tests).
//
//   cmake -S native -B native/build -G Ninja && cmake --build native/build && ctest --test-dir native/build

#ifdef RANGE_SOURCE_TESTS_THROUGH_ABI
#define RANGE_SOURCE_CLIENT_NAMESPACE rangesource_client
#include "range_source.h"
#include "range_source_download.h"

#include <dirent.h>
#else
#include "RangeReader.h"
#include "Store.h"
#endif

#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <functional>
#include <mutex>
#include <string>
#include <sys/stat.h>
#include <thread>
#include <unistd.h>
#include <vector>

#ifdef RANGE_SOURCE_TESTS_THROUGH_ABI

using namespace rangesource_client;
using TestAbort = std::atomic<int32_t>;

extern "C" int range_source_c_tests(char* failure, size_t failureSize);

namespace {

std::shared_ptr<Store> diskStore(const std::string& dir, int64_t maxBytes) {
    return Store::disk(range_source_plugin(), dir, maxBytes);
}

std::shared_ptr<Store> memoryStore(const std::string& name, int64_t maxBytes) {
    return Store::memory(range_source_plugin(), name, maxBytes);
}

std::shared_ptr<RangeReader> openRaw(std::unique_ptr<Upstream> upstream, const std::shared_ptr<Store>& store,
                                     const std::string& key, const ReaderOptions& options, std::string& error) {
    return RangeReader::open(range_source_plugin(), std::move(upstream), store, key, options, error);
}

bool holds(const std::shared_ptr<Store>& store, const std::string& key) {
    return store->holds(key) != RANGE_SOURCE_HOLDS_NONE;
}

bool holdsWhole(const std::shared_ptr<Store>& store, const std::string& key) {
    return store->holds(key) == RANGE_SOURCE_HOLDS_WHOLE;
}

} // namespace

#else

using namespace rangesource;
using TestAbort = std::atomic<bool>;

namespace {

std::shared_ptr<Store> diskStore(const std::string& dir, int64_t maxBytes) {
    return Store::disk(dir, maxBytes);
}

std::shared_ptr<Store> memoryStore(const std::string& name, int64_t maxBytes) {
    return Store::memory(name, maxBytes);
}

std::shared_ptr<RangeReader> openRaw(std::unique_ptr<Upstream> upstream, const std::shared_ptr<Store>& store,
                                     const std::string& key, const ReaderOptions& options, std::string& error) {
    return RangeReader::open(std::move(upstream), store, key, options, error);
}

bool holds(const std::shared_ptr<Store>& store, const std::string& key) {
    return store->find(key) != nullptr;
}

bool holdsWhole(const std::shared_ptr<Store>& store, const std::string& key) {
    auto file = store->find(key);
    return file && file->complete();
}

} // namespace

#endif

namespace {

int failures = 0;

#define CHECK(cond, ...)                                                       \
    do {                                                                       \
        if (!(cond)) {                                                         \
            failures++;                                                        \
            std::fprintf(stderr, "  FAIL %s:%d: %s ", __FILE__, __LINE__, #cond); \
            std::fprintf(stderr, "" __VA_ARGS__);                              \
            std::fprintf(stderr, "\n");                                        \
        }                                                                      \
    } while (0)

std::vector<std::pair<const char*, std::function<void()>>>& tests() {
    static std::vector<std::pair<const char*, std::function<void()>>> all;
    return all;
}

struct Register {
    Register(const char* name, std::function<void()> fn) { tests().emplace_back(name, std::move(fn)); }
};

#define TEST(name)                                  \
    static void name();                             \
    static Register register_##name(#name, name);   \
    static void name()

constexpr int64_t KB = 1024;
constexpr int64_t MB = 1024 * KB;

std::vector<uint8_t> makeContent(int64_t size, uint32_t seed) {
    std::vector<uint8_t> bytes(static_cast<size_t>(size));
    uint32_t x = seed;
    for (auto& b : bytes) {
        x = x * 1664525u + 1013904223u;
        b = static_cast<uint8_t>(x >> 24);
    }
    return bytes;
}

/** The far end: a file served to any number of FakeUpstreams, with faults to order. */
struct Remote {
    std::mutex mutex;
    std::vector<uint8_t> content;
    std::string etag = "v1";
    bool knowsSize = true;
    std::atomic<bool> offline{false};
    std::string offlineError = "offline";
    int64_t chunk = 16 * KB;
    int readDelayUs = 0;
    int failOpens = 0;
    // A read crossing this offset fails, once
    int64_t dropAt = -1;
    // Reads wait while set, until cancelled
    std::atomic<bool> stall{false};
    std::vector<int64_t> opens;
    int64_t bytesSent = 0;

    std::vector<int64_t> openPositions() {
        std::lock_guard<std::mutex> lock(mutex);
        return opens;
    }
};

class FakeUpstream : public Upstream {
public:
    explicit FakeUpstream(std::shared_ptr<Remote> remote) : remote_(std::move(remote)) {}

    bool open(int64_t position, SourceInfo& info, std::string& error) override {
        std::lock_guard<std::mutex> lock(remote_->mutex);
        cancelled_ = false;
        if (remote_->offline) {
            error = remote_->offlineError;
            return false;
        }
        if (remote_->failOpens > 0) {
            remote_->failOpens--;
            error = "refused";
            return false;
        }
        remote_->opens.push_back(position);
        const int64_t size = static_cast<int64_t>(remote_->content.size());
        pos_ = std::min(position, size);
        info.size = remote_->knowsSize ? size : -1;
        info.etag = remote_->etag;
        return true;
    }

    int64_t read(uint8_t* out, int64_t size, std::string& error) override {
        for (;;) {
            {
                std::lock_guard<std::mutex> lock(remote_->mutex);
                if (!remote_->stall || cancelled_) break;
            }
            std::this_thread::sleep_for(std::chrono::milliseconds(1));
        }
        if (remote_->readDelayUs) std::this_thread::sleep_for(std::chrono::microseconds(remote_->readDelayUs));
        std::lock_guard<std::mutex> lock(remote_->mutex);
        if (cancelled_ || pos_ < 0) {
            error = "cancelled";
            return -1;
        }
        const int64_t n = std::min({size, remote_->chunk, static_cast<int64_t>(remote_->content.size()) - pos_});
        if (remote_->dropAt >= pos_ && remote_->dropAt < pos_ + std::max<int64_t>(n, 1)) {
            remote_->dropAt = -1;
            error = "connection reset";
            return -1;
        }
        std::memcpy(out, remote_->content.data() + pos_, static_cast<size_t>(n));
        pos_ += n;
        remote_->bytesSent += n;
        return n;
    }

    void close() override {
        std::lock_guard<std::mutex> lock(remote_->mutex);
        pos_ = -1;
    }

    void cancel() override {
        std::lock_guard<std::mutex> lock(remote_->mutex);
        cancelled_ = true;
    }

private:
    std::shared_ptr<Remote> remote_;
    int64_t pos_ = -1;
    bool cancelled_ = false;
};

std::shared_ptr<Remote> remoteOf(int64_t size, uint32_t seed = 1) {
    auto remote = std::make_shared<Remote>();
    remote->content = makeContent(size, seed);
    return remote;
}

ReaderOptions quickRetries() {
    ReaderOptions options;
    options.retryDelayMs = 1;
    return options;
}

std::shared_ptr<RangeReader> openReader(const std::shared_ptr<Remote>& remote, std::shared_ptr<Store> store = nullptr,
                                        const std::string& key = "", ReaderOptions options = quickRetries()) {
    std::string error;
    auto reader = openRaw(std::make_unique<FakeUpstream>(remote), store, key, options, error);
    CHECK(reader, "open failed: %s", error.c_str());
    return reader;
}

// Reads [pos, pos + size) as a demuxer would, in pieces
template <class Reader>
bool readsMatch(Reader& reader, const std::vector<uint8_t>& content, int64_t pos, int64_t size,
                int64_t piece = 64 * KB) {
    std::vector<uint8_t> buffer(static_cast<size_t>(piece));
    const int64_t end = std::min<int64_t>(pos + size, static_cast<int64_t>(content.size()));
    while (pos < end) {
        const int64_t n = reader.read(pos, buffer.data(), std::min(piece, end - pos));
        if (n <= 0) {
            std::fprintf(stderr, "  read at %lld returned %lld (%s)\n", (long long)pos, (long long)n,
                         reader.lastError().c_str());
            return false;
        }
        if (std::memcmp(buffer.data(), content.data() + pos, static_cast<size_t>(n)) != 0) {
            std::fprintf(stderr, "  bytes differ at %lld\n", (long long)pos);
            return false;
        }
        pos += n;
    }
    return true;
}

std::vector<std::string>& tempDirs() {
    static std::vector<std::string> all;
    return all;
}

std::string tempDir(const char* name) {
    static int counter = 0;
    std::string dir = "/tmp/range-source-test-" + std::to_string(getpid()) + "-" + std::to_string(counter++) + "-" + name;
    std::system(("rm -rf '" + dir + "'").c_str());
    tempDirs().push_back(dir);
    return dir;
}

void waitFor(const std::function<bool()>& done, int ms = 2000) {
    for (int i = 0; i < ms && !done(); i++) std::this_thread::sleep_for(std::chrono::milliseconds(1));
}

} // namespace

//==============================================================================
// Reading
//==============================================================================

TEST(readsTheWholeFileInOneRequest) {
    auto remote = remoteOf(5 * MB + 12345);
    auto reader = openReader(remote);
    CHECK(reader->size() == static_cast<int64_t>(remote->content.size()));
    CHECK(readsMatch(*reader, remote->content, 0, 1LL << 40));
    CHECK(remote->openPositions().size() == 1, "%zu opens", remote->openPositions().size());
    std::vector<uint8_t> byte(1);
    CHECK(reader->read(static_cast<int64_t>(remote->content.size()), byte.data(), 1) == 0);
}

TEST(aSeekReconnectsAtItsBlockAndReadsOnFromThere) {
    auto remote = remoteOf(8 * MB);
    auto reader = openReader(remote);
    CHECK(readsMatch(*reader, remote->content, 0, 100 * KB));
    // Read-ahead done, so that coming back below needs nothing
    waitFor([&] { return reader->stats().bytesFetched >= 100 * KB + 2 * MB; });
    CHECK(readsMatch(*reader, remote->content, 6 * MB + 1000, 1 * MB));
    std::vector<int64_t> opens = remote->openPositions();
    CHECK(opens.size() == 2, "%zu opens", opens.size());
    if (opens.size() == 2) CHECK(opens[1] == 6 * MB, "reopened at %lld", (long long)opens[1]);
    // Back to the start: held in memory, no request
    CHECK(readsMatch(*reader, remote->content, 0, 100 * KB));
    CHECK(remote->openPositions().size() == 2);
}

TEST(aSeekDuringReadAheadDoesntGoBack) {
    auto remote = remoteOf(8 * MB);
    auto reader = openReader(remote);
    CHECK(readsMatch(*reader, remote->content, 0, 100 * KB));
    CHECK(readsMatch(*reader, remote->content, 6 * MB + 1000, 1 * MB));
    std::vector<int64_t> opens = remote->openPositions();
    CHECK(opens.size() == 2, "%zu opens", opens.size());
}

TEST(aShortSkipReadsThrough) {
    auto remote = remoteOf(4 * MB);
    ReaderOptions options = quickRetries();
    options.readAheadBytes = 0;
    auto reader = openReader(remote, nullptr, "", options);
    CHECK(readsMatch(*reader, remote->content, 0, 10 * KB));
    CHECK(readsMatch(*reader, remote->content, 600 * KB, 10 * KB));
    CHECK(remote->openPositions().size() == 1, "%zu opens", remote->openPositions().size());
}

TEST(readsAheadInTheBackground) {
    auto remote = remoteOf(8 * MB);
    auto reader = openReader(remote);
    CHECK(readsMatch(*reader, remote->content, 0, 10 * KB));
    waitFor([&] { return reader->stats().bytesFetched >= 2 * MB; });
    const int64_t fetched = reader->stats().bytesFetched;
    CHECK(fetched >= 2 * MB && fetched <= 3 * MB, "fetched %lld", (long long)fetched);
}

TEST(aReadReturnsTheBytesOfABlockAsTheyArrive) {
    auto remote = remoteOf(2 * MB);
    remote->chunk = 4 * KB;
    remote->readDelayUs = 2000;
    auto reader = openReader(remote);
    std::vector<uint8_t> buffer(256 * KB);
    const auto start = std::chrono::steady_clock::now();
    const int64_t n = reader->read(0, buffer.data(), 256 * KB);
    const auto ms = std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now() - start).count();
    CHECK(n > 0 && n < 256 * KB, "read %lld", (long long)n);
    CHECK(ms < 60, "took %lld ms", (long long)ms);
    CHECK(std::memcmp(buffer.data(), remote->content.data(), static_cast<size_t>(n)) == 0);
}

TEST(aDroppedConnectionIsReopened) {
    auto remote = remoteOf(3 * MB);
    remote->dropAt = 1 * MB + 5000;
    auto reader = openReader(remote);
    CHECK(readsMatch(*reader, remote->content, 0, 1LL << 40));
    std::vector<int64_t> opens = remote->openPositions();
    CHECK(opens.size() == 2, "%zu opens", opens.size());
    if (opens.size() == 2) CHECK(opens[1] == 1 * MB, "reopened at %lld", (long long)opens[1]);
}

TEST(failsAReadOnceRetriesRunOut) {
    auto remote = remoteOf(3 * MB);
    auto reader = openReader(remote);
    {
        std::lock_guard<std::mutex> lock(remote->mutex);
        remote->offline = true;
    }
    std::vector<uint8_t> buffer(1000);
    CHECK(reader->read(2 * MB, buffer.data(), 1000) == -1);
    CHECK(reader->lastError() == "offline", "error %s", reader->lastError().c_str());
    {
        std::lock_guard<std::mutex> lock(remote->mutex);
        remote->offline = false;
    }
    // The next read tries again
    CHECK(readsMatch(*reader, remote->content, 2 * MB, 1000));
}

TEST(openFailsWhenTheSourceCantBeOpened) {
    auto remote = remoteOf(1 * MB);
    remote->offline = true;
    std::string error;
    auto reader = openRaw(std::make_unique<FakeUpstream>(remote), nullptr, "", quickRetries(), error);
    CHECK(!reader);
    CHECK(error == "offline");
}

TEST(aSizeFoundAtTheEnd) {
    auto remote = remoteOf(1 * MB + 777);
    remote->knowsSize = false;
    auto reader = openReader(remote);
    CHECK(reader->size() == -1);
    CHECK(readsMatch(*reader, remote->content, 0, 1LL << 40));
    std::vector<uint8_t> byte(1);
    CHECK(reader->read(static_cast<int64_t>(remote->content.size()), byte.data(), 1) == 0);
    CHECK(reader->size() == static_cast<int64_t>(remote->content.size()), "size %lld", (long long)reader->size());
}

TEST(abortStopsAWaitingRead) {
    auto remote = remoteOf(1 * MB);
    // Before the fetch thread's read-ahead can get there
    remote->stall = true;
    auto reader = openReader(remote);
    TestAbort abort{false};
    std::thread later([&] {
        std::this_thread::sleep_for(std::chrono::milliseconds(100));
        abort = true;
    });
    std::vector<uint8_t> buffer(1000);
    CHECK(reader->read(500 * KB, buffer.data(), 1000, &abort) == -1);
    later.join();
    remote->stall = false;
}

TEST(closingDoesntWaitForTheUpstream) {
    auto remote = remoteOf(1 * MB);
    remote->stall = true;
    auto reader = openReader(remote);
    std::vector<uint8_t> buffer(1000);
    std::thread reading([&] { CHECK(reader->read(0, buffer.data(), 1000) == -1); });
    std::this_thread::sleep_for(std::chrono::milliseconds(50));
    const auto start = std::chrono::steady_clock::now();
    reader->close();
    reading.join();
    const auto ms = std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now() - start).count();
    CHECK(ms < 200, "took %lld ms", (long long)ms);
    reader.reset();
    remote->stall = false;
}

TEST(tryReadAsksForTheBytesAndFindsThemLater) {
    auto remote = remoteOf(8 * MB);
    remote->readDelayUs = 200;
    auto reader = openReader(remote);
    std::vector<uint8_t> buffer(1000);
    const int64_t pos = 6 * MB + 100;
    CHECK(reader->tryRead(pos, buffer.data(), 1000) == RangeReader::kPending);
    int64_t n = RangeReader::kPending;
    waitFor([&] { return (n = reader->tryRead(pos, buffer.data(), 1000)) != RangeReader::kPending; });
    CHECK(n == 1000, "read %lld", (long long)n);
    CHECK(std::memcmp(buffer.data(), remote->content.data() + pos, 1000) == 0);
    std::vector<int64_t> opens = remote->openPositions();
    CHECK(opens.size() == 2 && opens[1] == 6 * MB, "%zu opens", opens.size());
    // Reading on in order, polling, stays on that request
    std::vector<uint8_t> piece(64 * KB);
    for (int64_t at = pos + 1000; at < 8 * MB;) {
        int64_t got = RangeReader::kPending;
        waitFor([&] { return (got = reader->tryRead(at, piece.data(), 64 * KB)) != RangeReader::kPending; });
        if (got <= 0) {
            CHECK(got > 0, "read at %lld returned %lld", (long long)at, (long long)got);
            break;
        }
        CHECK(std::memcmp(piece.data(), remote->content.data() + at, static_cast<size_t>(got)) == 0);
        at += got;
    }
    CHECK(remote->openPositions().size() == 2, "%zu opens", remote->openPositions().size());
}

TEST(tryReadReportsAFailedFetchOnceThenAsksAgain) {
    auto remote = remoteOf(3 * MB);
    auto reader = openReader(remote);
    {
        std::lock_guard<std::mutex> lock(remote->mutex);
        remote->offline = true;
    }
    std::vector<uint8_t> buffer(1000);
    CHECK(reader->tryRead(2 * MB, buffer.data(), 1000) == RangeReader::kPending);
    int64_t n = RangeReader::kPending;
    waitFor([&] { return (n = reader->tryRead(2 * MB, buffer.data(), 1000)) != RangeReader::kPending; });
    CHECK(n == -1, "read %lld", (long long)n);
    CHECK(reader->lastError() == "offline", "error %s", reader->lastError().c_str());
    {
        std::lock_guard<std::mutex> lock(remote->mutex);
        remote->offline = false;
    }
    waitFor([&] { return (n = reader->tryRead(2 * MB, buffer.data(), 1000)) != RangeReader::kPending; });
    CHECK(n == 1000, "read %lld", (long long)n);
    CHECK(std::memcmp(buffer.data(), remote->content.data() + 2 * MB, 1000) == 0);
}

TEST(fetchAllReadsEveryByte) {
    auto remote = remoteOf(3 * MB + 1);
    auto reader = openReader(remote);
    CHECK(reader->fetchAll());
    CHECK(remote->bytesSent == static_cast<int64_t>(remote->content.size()), "sent %lld", (long long)remote->bytesSent);
}

//==============================================================================
// Stores
//==============================================================================

TEST(aStoredFilePlaysOffline) {
    auto store = diskStore(tempDir("offline"), 64 * MB);
    CHECK(store);
    auto remote = remoteOf(3 * MB + 100);
    {
        auto reader = openReader(remote, store, "clip");
        CHECK(readsMatch(*reader, remote->content, 0, 1LL << 40));
    }
    waitFor([&] { return store->bytesUsed() == static_cast<int64_t>(remote->content.size()); });
    CHECK(store->bytesUsed() == static_cast<int64_t>(remote->content.size()), "used %lld", (long long)store->bytesUsed());
    remote->offline = true;
    auto reader = openReader(remote, store, "clip");
    CHECK(readsMatch(*reader, remote->content, 0, 1LL << 40));
}

TEST(fetchAllReturnsOnceTheStoreHoldsEveryBlock) {
    auto store = diskStore(tempDir("fetchall"), 64 * MB);
    auto remote = remoteOf(100 * KB + 1);
    // Closing at once must not lose the last block, which reads can take before it's stored
    for (int i = 0; i < 300; i++) {
        const std::string key = "clip" + std::to_string(i);
        auto reader = openReader(remote, store, key);
        CHECK(reader->fetchAll());
        reader->close();
        CHECK(holdsWhole(store, key), "try %d: not whole", i);
    }
}

TEST(aStoreSurvivesTheProcess) {
    const std::string dir = tempDir("reload");
    auto remote = remoteOf(1 * MB + 3);
    {
        auto store = diskStore(dir, 64 * MB);
        auto reader = openReader(remote, store, "https://example.com/a.webm");
        CHECK(readsMatch(*reader, remote->content, 0, 1LL << 40));
        reader.reset();
        waitFor([&] { return store->bytesUsed() == static_cast<int64_t>(remote->content.size()); });
    }
    // Another path to the folder is another store, which reads the index from disk
    auto store = diskStore(dir + "/.", 64 * MB);
    CHECK(store->bytesUsed() == static_cast<int64_t>(remote->content.size()), "used %lld", (long long)store->bytesUsed());
    remote->offline = true;
    auto reader = openReader(remote, store, "https://example.com/a.webm");
    CHECK(readsMatch(*reader, remote->content, 0, 1LL << 40));
}

TEST(aPartialCopyIsCheckedAndKept) {
    auto store = diskStore(tempDir("partial"), 64 * MB);
    auto remote = remoteOf(4 * MB);
    ReaderOptions options = quickRetries();
    options.readAheadBytes = 0;
    {
        auto reader = openReader(remote, store, "clip", options);
        CHECK(readsMatch(*reader, remote->content, 0, 1 * MB));
    }
    const int64_t sent = remote->bytesSent;
    auto reader = openReader(remote, store, "clip", options);
    CHECK(readsMatch(*reader, remote->content, 0, 1 * MB));
    // The first MB came from the store; only the open's first chunk went over the wire
    CHECK(remote->bytesSent - sent <= 16 * KB, "sent %lld more", (long long)(remote->bytesSent - sent));
}

TEST(aChangedSourceReplacesTheCopy) {
    auto store = diskStore(tempDir("changed"), 64 * MB);
    auto remote = remoteOf(2 * MB);
    ReaderOptions options = quickRetries();
    options.readAheadBytes = 0;
    {
        auto reader = openReader(remote, store, "clip", options);
        CHECK(readsMatch(*reader, remote->content, 0, 512 * KB));
    }
    remote->content = makeContent(2 * MB, 2);
    remote->etag = "v2";
    auto reader = openReader(remote, store, "clip", options);
    CHECK(readsMatch(*reader, remote->content, 0, 1LL << 40));
}

TEST(aChangeWhilePlayingFailsTheRead) {
    auto store = diskStore(tempDir("midway"), 64 * MB);
    auto remote = remoteOf(4 * MB);
    ReaderOptions options = quickRetries();
    options.readAheadBytes = 0;
    auto reader = openReader(remote, store, "clip", options);
    CHECK(readsMatch(*reader, remote->content, 0, 100 * KB));
    {
        std::lock_guard<std::mutex> lock(remote->mutex);
        remote->etag = "v2";
    }
    std::vector<uint8_t> buffer(100);
    CHECK(reader->read(3 * MB, buffer.data(), 100) == -1);
    CHECK(reader->lastError() == "the source changed while it was read", "%s", reader->lastError().c_str());
    CHECK(!holds(store, "clip"));
}

TEST(theCapEvictsTheLeastRecentlyUsed) {
    auto store = diskStore(tempDir("evict"), 5 * MB);
    auto a = remoteOf(2 * MB, 1), b = remoteOf(2 * MB, 2), c = remoteOf(2 * MB, 3);
    for (auto& [key, remote] : std::vector<std::pair<std::string, std::shared_ptr<Remote>>>{{"a", a}, {"b", b}, {"c", c}}) {
        auto reader = openReader(remote, store, key);
        CHECK(readsMatch(*reader, remote->content, 0, 1LL << 40));
        reader.reset();
        waitFor([&] { return holdsWhole(store, key); });
    }
    CHECK(store->bytesUsed() <= 5 * MB, "used %lld", (long long)store->bytesUsed());
    CHECK(!holds(store, "a"));
    CHECK(holds(store, "b") && holds(store, "c"));
}

TEST(anOpenKeyIsntEvicted) {
    auto store = diskStore(tempDir("open"), 3 * MB);
    auto a = remoteOf(2 * MB, 1), b = remoteOf(2 * MB, 2);
    auto readerA = openReader(a, store, "a");
    CHECK(readsMatch(*readerA, a->content, 0, 1LL << 40));
    auto readerB = openReader(b, store, "b");
    CHECK(readsMatch(*readerB, b->content, 0, 1LL << 40));
    CHECK(holdsWhole(store, "a"));
}

TEST(aMemoryStoreIsSharedByReaders) {
    auto store = memoryStore("test", 64 * MB);
    auto remote = remoteOf(1 * MB);
    {
        auto reader = openReader(remote, store, "clip");
        CHECK(readsMatch(*reader, remote->content, 0, 1LL << 40));
    }
    remote->offline = true;
    auto reader = openReader(remote, store, "clip");
    CHECK(readsMatch(*reader, remote->content, 0, 1LL << 40));
}

TEST(aMissingBlockIsFetchedAgain) {
    const std::string dir = tempDir("missing");
    auto store = diskStore(dir, 64 * MB);
    auto remote = remoteOf(1 * MB);
    {
        auto reader = openReader(remote, store, "clip");
        CHECK(readsMatch(*reader, remote->content, 0, 1LL << 40));
    }
    // Something truncated the data file behind the store's back
    std::system(("for f in '" + dir + "'/*.data; do : > \"$f\"; done").c_str());
    auto reader = openReader(remote, store, "clip");
    CHECK(readsMatch(*reader, remote->content, 0, 1LL << 40));
}

#ifdef RANGE_SOURCE_TESTS_THROUGH_ABI

//==============================================================================
// The C table
//==============================================================================

TEST(theTableHasEveryFunction) {
    const RangeSourcePlugin* p = range_source_plugin();
    CHECK(p->abi == RANGE_SOURCE_ABI);
    CHECK(p->structSize == sizeof(RangeSourcePlugin));
    CHECK(p->version && *p->version);
    // Every member after `version` is a function pointer
    const auto* functions = reinterpret_cast<void* const*>(reinterpret_cast<const char*>(p) + offsetof(RangeSourcePlugin, diskStore));
    const size_t count = (sizeof(RangeSourcePlugin) - offsetof(RangeSourcePlugin, diskStore)) / sizeof(void*);
    for (size_t i = 0; i < count; i++) CHECK(functions[i], "function %zu is null", i);
}

TEST(anUpstreamInCReadsThroughTheTable) {
    char failure[256] = "";
    CHECK(range_source_c_tests(failure, sizeof(failure)), "%s", failure);
}

TEST(aLongUpstreamErrorIsCutNotLost) {
    auto remote = remoteOf(4 * MB);
    ReaderOptions options = quickRetries();
    options.readAheadBytes = 0;
    auto reader = openReader(remote, nullptr, "", options);
    const std::string message(2000, 'x');
    {
        std::lock_guard<std::mutex> lock(remote->mutex);
        remote->offlineError = message;
        remote->offline = true;
    }
    std::vector<uint8_t> buffer(10);
    // Far from the open read, so it reopens
    CHECK(reader->read(3 * MB, buffer.data(), 10) == -1);
    CHECK(reader->lastError() == message.substr(0, 511), "%zu characters", reader->lastError().size());
}

//==============================================================================
// The basic input: DownloadReader
//==============================================================================

std::shared_ptr<DownloadReader> openDownload(const std::shared_ptr<Remote>& remote, const std::string& dir) {
    std::string error;
    DownloadReader::Options options;
    options.retryDelayMs = 1;
    auto reader = DownloadReader::open(std::make_unique<FakeUpstream>(remote), dir, error, options);
    CHECK(reader, "open failed: %s", error.c_str());
    return reader;
}

int filesIn(const std::string& dir) {
    int count = 0;
    if (DIR* d = opendir(dir.c_str())) {
        while (dirent* entry = readdir(d)) {
            if (entry->d_name[0] != '.') count++;
        }
        closedir(d);
    }
    return count;
}

std::string madeDir(const char* name) {
    const std::string dir = tempDir(name);
    mkdir(dir.c_str(), 0755);
    return dir;
}

TEST(aDownloadReadsTheFileInOneRequest) {
    auto remote = remoteOf(3 * MB + 17);
    auto reader = openDownload(remote, madeDir("download"));
    CHECK(reader->size() == static_cast<int64_t>(remote->content.size()));
    CHECK(readsMatch(*reader, remote->content, 2 * MB, 1LL << 40));
    CHECK(readsMatch(*reader, remote->content, 0, 1LL << 40));
    CHECK(reader->fetchAll());
    CHECK(remote->openPositions().size() == 1, "%zu opens", remote->openPositions().size());
    std::vector<uint8_t> byte(1);
    CHECK(reader->read(static_cast<int64_t>(remote->content.size()), byte.data(), 1) == 0);
}

TEST(aDownloadLeavesNoFile) {
    const std::string dir = madeDir("unlinked");
    auto remote = remoteOf(1 * MB);
    auto reader = openDownload(remote, dir);
    CHECK(filesIn(dir) == 0, "%d files", filesIn(dir));
    CHECK(reader->fetchAll());
    CHECK(filesIn(dir) == 0, "%d files", filesIn(dir));
}

TEST(aDownloadReadWaitsForItsBytes) {
    auto remote = remoteOf(2 * MB);
    remote->chunk = 16 * KB;
    remote->readDelayUs = 500;
    auto reader = openDownload(remote, madeDir("wait"));
    std::vector<uint8_t> buffer(1000);
    const int64_t pos = 2 * MB - 1000;
    CHECK(reader->tryRead(pos, buffer.data(), 1000) == Reader::kPending);
    CHECK(reader->read(pos, buffer.data(), 1000) == 1000);
    CHECK(std::memcmp(buffer.data(), remote->content.data() + pos, 1000) == 0);
}

TEST(aDroppedDownloadResumesWhereItStopped) {
    auto remote = remoteOf(3 * MB);
    remote->dropAt = 1 * MB + 5000;
    auto reader = openDownload(remote, madeDir("resume"));
    CHECK(readsMatch(*reader, remote->content, 0, 1LL << 40));
    std::vector<int64_t> opens = remote->openPositions();
    CHECK(opens.size() == 2, "%zu opens", opens.size());
    if (opens.size() == 2) CHECK(opens[1] > 0 && opens[1] <= 1 * MB + 5000, "reopened at %lld", (long long)opens[1]);
}

TEST(aDownloadFailsWhenTheSourceChanges) {
    auto remote = remoteOf(3 * MB);
    remote->dropAt = 1 * MB;
    remote->readDelayUs = 200;
    {
        std::lock_guard<std::mutex> lock(remote->mutex);
        remote->etag = "v1";
    }
    auto reader = openDownload(remote, madeDir("changed"));
    {
        std::lock_guard<std::mutex> lock(remote->mutex);
        remote->etag = "v2";
    }
    std::vector<uint8_t> buffer(100);
    CHECK(reader->read(2 * MB, buffer.data(), 100) == -1);
    CHECK(reader->lastError() == "the source changed while it was read", "%s", reader->lastError().c_str());
    CHECK(!reader->fetchAll());
}

TEST(aDownloadFailsOnceRetriesRunOut) {
    auto remote = remoteOf(3 * MB);
    remote->dropAt = 1 * MB;
    remote->readDelayUs = 200;
    auto reader = openDownload(remote, madeDir("offline"));
    remote->offline = true;
    std::vector<uint8_t> buffer(100);
    CHECK(reader->read(2 * MB, buffer.data(), 100) == -1);
    CHECK(reader->lastError() == "offline", "%s", reader->lastError().c_str());
    // What arrived before still reads
    CHECK(readsMatch(*reader, remote->content, 0, 512 * KB));
}

TEST(aDownloadLearnsItsSizeAtTheEnd) {
    auto remote = remoteOf(1 * MB + 333);
    remote->knowsSize = false;
    auto reader = openDownload(remote, madeDir("unknown"));
    CHECK(reader->size() == -1);
    CHECK(readsMatch(*reader, remote->content, 0, 1LL << 40));
    std::vector<uint8_t> byte(1);
    CHECK(reader->read(static_cast<int64_t>(remote->content.size()), byte.data(), 1) == 0);
    CHECK(reader->size() == static_cast<int64_t>(remote->content.size()), "size %lld", (long long)reader->size());
}

TEST(closingADownloadDoesntWaitForTheUpstream) {
    auto remote = remoteOf(1 * MB);
    remote->stall = true;
    auto reader = openDownload(remote, madeDir("close"));
    std::vector<uint8_t> buffer(1000);
    std::thread reading([&] { CHECK(reader->read(0, buffer.data(), 1000) == -1); });
    std::this_thread::sleep_for(std::chrono::milliseconds(50));
    const auto start = std::chrono::steady_clock::now();
    reader->close();
    reading.join();
    const auto ms = std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now() - start).count();
    CHECK(ms < 200, "took %lld ms", (long long)ms);
    reader.reset();
    remote->stall = false;
}

TEST(abortStopsAWaitingDownloadRead) {
    auto remote = remoteOf(1 * MB);
    remote->stall = true;
    auto reader = openDownload(remote, madeDir("abort"));
    TestAbort abort{false};
    std::thread later([&] {
        std::this_thread::sleep_for(std::chrono::milliseconds(100));
        abort = true;
    });
    std::vector<uint8_t> buffer(1000);
    CHECK(reader->read(500 * KB, buffer.data(), 1000, &abort) == -1);
    CHECK(!reader->fetchAll(&abort));
    later.join();
    remote->stall = false;
}

TEST(aDownloadCantStartWithoutItsFolder) {
    auto remote = remoteOf(1 * MB);
    std::string error;
    auto reader = DownloadReader::open(std::make_unique<FakeUpstream>(remote), "/nonexistent/folder", error);
    CHECK(!reader);
    CHECK(error.find("/nonexistent/folder") != std::string::npos, "%s", error.c_str());
    CHECK(remote->openPositions().empty());
}

#endif

int main() {
    for (auto& [name, fn] : tests()) {
        const int before = failures;
        fn();
        std::printf("%s %s\n", failures == before ? "ok  " : "FAIL", name);
    }
    std::printf("%zu tests, %d failures\n", tests().size(), failures);
    for (const auto& dir : tempDirs()) std::system(("rm -rf '" + dir + "'").c_str());
    return failures == 0 ? 0 : 1;
}
