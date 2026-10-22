/**
 * RangeSourceInternal.h
 * Shared by the add-on's Objective-C files; not part of the public API.
 */

#import "RangeSource.h"

#ifdef __cplusplus

// range_source.h's C types RangeSourceStore, RangeSourceReader, RangeSourceReaderOptions and
// RangeSourceStats have the names of this API's classes, so here they take others. The table's
// layout is the same either way.
#define RangeSourceStore RangeSourceStoreHandle
#define RangeSourceReader RangeSourceReaderHandle
#define RangeSourceReaderOptions RangeSourceReaderOptionsC
#define RangeSourceStats RangeSourceStatsC
#define RANGE_SOURCE_CLIENT_NAMESPACE rs_objc
#include "range_source.h"
#undef RangeSourceStore
#undef RangeSourceReader
#undef RangeSourceReaderOptions
#undef RangeSourceStats

#include <memory>

NS_ASSUME_NONNULL_BEGIN

/** Reads `url` with URLSession: a `Range: bytes=N-` request per open, kept open as the reader reads on. */
std::unique_ptr<rs_objc::Upstream> RangeSourceURLSessionUpstream(NSURL *url, NSDictionary<NSString *, NSString *> *headers);

/** Reads `url` through an app's data source, a window of a few megabytes at a time. */
std::unique_ptr<rs_objc::Upstream> RangeSourceDataSourceUpstream(id<RangeDataSource> dataSource, NSURL *url,
                                                                 NSDictionary<NSString *, NSString *> *headers);

NS_ASSUME_NONNULL_END

#endif
