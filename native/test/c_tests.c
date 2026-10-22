/* range_source.h used from C: an upstream over memory, read through the table. */

#include "range_source.h"

#include <stdio.h>
#include <string.h>
#include <unistd.h>

typedef struct MemoryUpstream {
    const uint8_t* bytes;
    int64_t size;
    int64_t pos;
    int failOpen;
    int releases;
} MemoryUpstream;

static int memoryOpen(void* context, int64_t position, RangeSourceInfo* info, char* error, size_t errorSize) {
    MemoryUpstream* m = (MemoryUpstream*)context;
    if (m->failOpen) {
        snprintf(error, errorSize, "no such file");
        return -1;
    }
    m->pos = position < m->size ? position : m->size;
    info->size = m->size;
    snprintf(info->etag, sizeof(info->etag), "\"c1\"");
    return 0;
}

static int64_t memoryRead(void* context, uint8_t* out, int64_t size, char* error, size_t errorSize) {
    MemoryUpstream* m = (MemoryUpstream*)context;
    (void)error;
    (void)errorSize;
    int64_t n = m->size - m->pos;
    if (n > size) n = size;
    if (n > 1000) n = 1000;
    memcpy(out, m->bytes + m->pos, (size_t)n);
    m->pos += n;
    return n;
}

static void memoryClose(void* context) {
    ((MemoryUpstream*)context)->pos = -1;
}

static void memoryRelease(void* context) {
    __atomic_add_fetch(&((MemoryUpstream*)context)->releases, 1, __ATOMIC_RELEASE);
}

static RangeSourceUpstream upstreamOf(MemoryUpstream* m) {
    RangeSourceUpstream u;
    memset(&u, 0, sizeof(u));
    u.structSize = sizeof(u);
    u.context = m;
    u.open = memoryOpen;
    u.read = memoryRead;
    u.close = memoryClose;
    u.release = memoryRelease;
    return u;
}

#define FAIL(...)                                    \
    do {                                             \
        snprintf(failure, failureSize, __VA_ARGS__); \
        return 0;                                    \
    } while (0)

/* 1 if every check passes; otherwise 0, with `failure` set. */
int range_source_c_tests(char* failure, size_t failureSize) {
    const RangeSourcePlugin* p = range_source_plugin();
    if (p->abi != RANGE_SOURCE_ABI) FAIL("abi %u", p->abi);
    if (p->structSize != sizeof(RangeSourcePlugin)) FAIL("structSize %u", p->structSize);

    static uint8_t bytes[300000];
    for (size_t i = 0; i < sizeof(bytes); i++) bytes[i] = (uint8_t)(i * 7 + 3);

    MemoryUpstream m = {bytes, (int64_t)sizeof(bytes), -1, 0, 0};
    RangeSourceUpstream u = upstreamOf(&m);
    RangeSourceReaderOptions options;
    memset(&options, 0xff, sizeof(options)); /* every field -1: the defaults */
    options.structSize = sizeof(options);
    options.readAheadBytes = 0;
    char error[256] = "";
    RangeSourceReader* reader = p->openReader(&u, NULL, "", &options, error, sizeof(error));
    if (!reader) FAIL("open failed: %s", error);
    if (p->size(reader) != (int64_t)sizeof(bytes)) FAIL("size %lld", (long long)p->size(reader));

    RangeSourceInfo info;
    p->info(reader, &info);
    if (strcmp(info.etag, "\"c1\"") != 0) FAIL("etag %s", info.etag);

    uint8_t out[4096];
    const int64_t at = 260000;
    const int64_t n = p->read(reader, at, out, sizeof(out), NULL);
    if (n <= 0) FAIL("read %lld", (long long)n);
    if (memcmp(out, bytes + at, (size_t)n) != 0) FAIL("bytes differ");
    if (p->read(reader, (int64_t)sizeof(bytes), out, 1, NULL) != 0) FAIL("read past the end");

    volatile int32_t abort = 1;
    if (p->read(reader, 1000, out, 10, &abort) != -1) FAIL("an aborted read returned bytes");

    /* The fetch thread lets go of the upstream once it ends, in the background */
    p->releaseReader(reader);
    for (int i = 0; i < 2000 && __atomic_load_n(&m.releases, __ATOMIC_ACQUIRE) == 0; i++) usleep(1000);
    if (m.releases != 1) FAIL("released %d times", m.releases);

    MemoryUpstream missing = {bytes, (int64_t)sizeof(bytes), -1, 1, 0};
    u = upstreamOf(&missing);
    error[0] = '\0';
    if (p->openReader(&u, NULL, "", NULL, error, sizeof(error))) FAIL("opened a file that isn't there");
    if (strcmp(error, "no such file") != 0) FAIL("error %s", error);
    if (missing.releases != 1) FAIL("a failed open released %d times", missing.releases);
    return 1;
}
