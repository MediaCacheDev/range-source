/**
 * RangeSource.h
 * range-source for iOS: reads a file by offset from a URL or an app's data source, by range
 * requests, through blocks in memory and an optional store on disk or in memory.
 *
 * Players find the add-on at runtime through the RangeSource class; an app only uses these
 * classes to read files itself, or to register data sources (RangeDataSource.h).
 */

#import <Foundation/Foundation.h>

#import "RangeDataSource.h"

NS_ASSUME_NONNULL_BEGIN

extern NSErrorDomain const RangeSourceErrorDomain;

/** What -[RangeSourceReader tryReadAt:into:length:] returns while the bytes are on their way. */
static const NSInteger RangeSourcePending = -2;

/** How much of a key a store holds. */
typedef NS_ENUM(NSInteger, RangeSourceHolds) {
    RangeSourceHoldsNone = 0,
    RangeSourceHoldsPart = 1,
    RangeSourceHoldsWhole = 2,
};

/**
 * Keeps files' bytes between reads, under a byte cap shared by every key in it; the least
 * recently used keys go first. One store per folder (or name, in memory) in the process: a later
 * call gets the same store, with its `maxBytes`.
 */
@interface RangeSourceStore : NSObject

+ (nullable instancetype)diskStoreAtPath:(NSString *)path
                                maxBytes:(int64_t)maxBytes
                                   error:(NSError **)error NS_SWIFT_NAME(disk(path:maxBytes:));
+ (instancetype)memoryStoreNamed:(NSString *)name maxBytes:(int64_t)maxBytes NS_SWIFT_NAME(memory(name:maxBytes:));
- (instancetype)init NS_UNAVAILABLE;

@property (nonatomic, readonly) int64_t bytesUsed;
- (void)setMaxBytes:(int64_t)maxBytes;
- (RangeSourceHolds)holdsKey:(NSString *)key NS_SWIFT_NAME(holds(key:));
- (void)removeKey:(NSString *)key NS_SWIFT_NAME(remove(key:));
- (void)clear;

@end

/** A reader's settings; a negative value takes the default. */
@interface RangeSourceReaderOptions : NSObject

/** Sent with every request for a URL, and given to a data source. */
@property (nonatomic, copy) NSDictionary<NSString *, NSString *> *headers;
/** Block size in bytes. Default 256 KB; a stored copy keeps the block size it was written with. */
@property (nonatomic) int64_t blockSize;
/** Bytes of blocks kept in memory, least recently used out. */
@property (nonatomic) int64_t memoryBytes;
/** After each read, fetch this many bytes past it in the background; 0 turns read-ahead off. */
@property (nonatomic) int64_t readAheadBytes;
/** A fetch this far past the open request's position reads on through it rather than reconnect. */
@property (nonatomic) int64_t reconnectGap;
/** Attempts after a failed open or read, each after twice the delay of the one before. */
@property (nonatomic) int retries;
@property (nonatomic) int64_t retryDelayMs;

@end

@interface RangeSourceStats : NSObject
/** Reads opened on the source, the first included. */
@property (nonatomic, readonly) int64_t opens;
/** Bytes read from the source. */
@property (nonatomic, readonly) int64_t bytesFetched;
@end

/**
 * A file read by offset, fetching on its own thread. Thread-safe; closes when released, or at
 * -close, which fails reads in progress.
 */
@interface RangeSourceReader : NSObject

/**
 * Opens `url`, through `dataSource` if given, else with URLSession. Learns the file's size and
 * version from a first request at 0, unless the store holds the file whole. Blocks on the
 * network, so not on the main queue.
 *
 * @param store keeps the blocks under `key` (the URL if nil); may be nil
 */
+ (nullable instancetype)openURL:(NSURL *)url
                      dataSource:(nullable id<RangeDataSource>)dataSource
                           store:(nullable RangeSourceStore *)store
                             key:(nullable NSString *)key
                         options:(nullable RangeSourceReaderOptions *)options
                           error:(NSError **)error
    NS_SWIFT_NAME(open(url:dataSource:store:key:options:));
- (instancetype)init NS_UNAVAILABLE;

/** The file's size, or -1 while it isn't known. */
@property (nonatomic, readonly) int64_t size;

/**
 * Reads up to `length` bytes at `position` into `buffer`, waiting for them. Returns how many:
 * fewer at a block's end, 0 at or past the end of the file, -1 if they can't be had (lastError).
 */
- (NSInteger)readAt:(int64_t)position into:(void *)buffer length:(NSInteger)length
    NS_SWIFT_NAME(read(at:into:length:));
/** As readAt:into:length:, as data: empty at the end of the file. */
- (nullable NSData *)readDataAt:(int64_t)position length:(NSInteger)length error:(NSError **)error
    NS_SWIFT_NAME(readData(at:length:));
/** readAt:into:length: without waiting, for a render loop: RangeSourcePending while the bytes are on their way. */
- (NSInteger)tryReadAt:(int64_t)position into:(void *)buffer length:(NSInteger)length
    NS_SWIFT_NAME(tryRead(at:into:length:));
/** Reads the whole file, so that the store holds it. Blocks. */
- (BOOL)fetchAll:(NSError **)error;

@property (nonatomic, readonly) NSString *lastError;
@property (nonatomic, readonly) RangeSourceStats *stats;

- (void)close;

@end

/** The add-on: its version, shortcuts to a reader, and what the players find it by. */
@interface RangeSource : NSObject

/** Such as "1.0.0". */
@property (class, nonatomic, readonly) NSString *versionString;

/** A reader over `url` with URLSession, kept in `store` under the URL. */
+ (nullable RangeSourceReader *)openURL:(NSURL *)url
                                  store:(nullable RangeSourceStore *)store
                                  error:(NSError **)error
    NS_SWIFT_NAME(open(url:store:));

/** For players: the add-on's C table, a RangeSourcePlugin (range_source.h). */
@property (class, nonatomic, readonly) const void *plugin;

/**
 * For players: fills `upstream`, a RangeSourceUpstream (range_source.h), with reads of `url`
 * through the data source registered as `name`. The caller owns it: it hands it to the table's
 * openReader, or calls its release. NO, leaving it untouched, if no data source has that name.
 */
+ (BOOL)getUpstream:(void *)upstream
    forDataSourceNamed:(NSString *)name
                   URL:(NSURL *)url
               headers:(NSDictionary<NSString *, NSString *> *)headers;

@end

NS_ASSUME_NONNULL_END
