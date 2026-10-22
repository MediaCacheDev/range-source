/**
 * RangeDataSource.h
 * Where a file's bytes come from, for an app that fetches, caches or decrypts them itself, and
 * the registry players find data sources in by name.
 */

#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

/** What a data source knows about a file, given at the start of each read. */
@interface RangeDataInfo : NSObject

/** The whole file's size in bytes (not what's left after the offset), or -1 if not known. */
@property (nonatomic, readonly) int64_t size;
/** An ETag, or any string that changes when the content does. */
@property (nonatomic, copy, readonly, nullable) NSString *etag;
/** Last-Modified, for sources without an ETag. */
@property (nonatomic, copy, readonly, nullable) NSString *lastModified;

- (instancetype)initWithSize:(int64_t)size
                        etag:(nullable NSString *)etag
                lastModified:(nullable NSString *)lastModified NS_DESIGNATED_INITIALIZER;
- (instancetype)init NS_UNAVAILABLE;

@end

/** A read in progress. */
@protocol RangeCancellable <NSObject>
/** Stops the read; the source may still call its handlers, which are then ignored. */
- (void)cancel;
@end

/**
 * Where a file's bytes come from: the role of AVAssetResourceLoaderDelegate, without the
 * AVFoundation types. The reader asks for byte ranges as it reads, a window of a few megabytes at
 * a time, and a new one at a seek.
 *
 * Shared by every reader it's given to, so a read must not depend on the one before.
 */
@protocol RangeDataSource <NSObject>

/**
 * Reads `length` bytes of `url` from `offset`, fewer at the end of the file. Call `response`
 * once, then `data` with the bytes in order (any number of times), then `completion` once: nil
 * when done, an error otherwise. A read at or past the end calls `response`, then `completion`
 * with nil. The handlers may be called on any thread, and soon after this returns or much later.
 *
 * @param headers the player's `headers`, for sources that make HTTP requests; may be empty
 */
- (id<RangeCancellable>)readURL:(NSURL *)url
                         offset:(int64_t)offset
                         length:(int64_t)length
                        headers:(NSDictionary<NSString *, NSString *> *)headers
                       response:(void (^)(RangeDataInfo *info))response
                           data:(void (^)(NSData *data))data
                     completion:(void (^)(NSError *_Nullable error))completion
    NS_SWIFT_NAME(read(url:offset:length:headers:response:data:completion:));

@end

/**
 * Data sources by name: register one here, then give a player its name (`dataSource`, or
 * `source={{ uri, dataSource: 'name' }}` in React Native). Thread-safe.
 */
@interface RangeDataSources : NSObject

/** Registers `dataSource` under `name`, replacing any registered before. */
+ (void)registerDataSource:(id<RangeDataSource>)dataSource name:(NSString *)name
    NS_SWIFT_NAME(register(_:name:));
+ (void)unregisterName:(NSString *)name NS_SWIFT_NAME(unregister(name:));
+ (nullable id<RangeDataSource>)dataSourceNamed:(NSString *)name NS_SWIFT_NAME(dataSource(named:));

@end

NS_ASSUME_NONNULL_END
