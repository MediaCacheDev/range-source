// The Java API (RangeSource, RangeSourceStore, RangeSourceReader) over the add-on's C table, the
// same one players use, and a native upstream over a Java RangeDataSource (SourceUpstream).
#define RANGE_SOURCE_CLIENT_NAMESPACE rs_jni
#include "range_source.h"

#include <jni.h>
#include <pthread.h>

#include <algorithm>
#include <memory>
#include <string>
#include <vector>

namespace {

const RangeSourcePlugin* table() {
    return range_source_plugin();
}

std::string stringFromJava(JNIEnv* env, jstring value) {
    if (!value) return {};
    const char* chars = env->GetStringUTFChars(value, nullptr);
    std::string result(chars);
    env->ReleaseStringUTFChars(value, chars);
    return result;
}

pthread_key_t detachKey;
pthread_once_t detachKeyOnce = PTHREAD_ONCE_INIT;

void detachThread(void* vm) {
    static_cast<JavaVM*>(vm)->DetachCurrentThread();
}

// This thread's env. A native thread is attached until it exits, as a reader's fetch thread calls
// into Java for as long as it runs.
JNIEnv* threadEnv(JavaVM* vm) {
    JNIEnv* env = nullptr;
    if (vm->GetEnv(reinterpret_cast<void**>(&env), JNI_VERSION_1_6) == JNI_OK) return env;
    if (vm->AttachCurrentThread(&env, nullptr) != JNI_OK) return nullptr;
    pthread_once(&detachKeyOnce, [] { pthread_key_create(&detachKey, detachThread); });
    pthread_setspecific(detachKey, vm);
    return env;
}

// Clears a pending Java exception; true if there was one.
bool clearException(JNIEnv* env) {
    if (!env->ExceptionCheck()) return false;
    env->ExceptionDescribe();
    env->ExceptionClear();
    return true;
}

void throwIOException(JNIEnv* env, const std::string& message) {
    jclass cls = env->FindClass("java/io/IOException");
    if (cls) env->ThrowNew(cls, message.c_str());
}

/** A SourceUpstream (Java), whose methods return failures rather than throw. */
class JavaUpstream : public rs_jni::Upstream {
public:
    static std::unique_ptr<JavaUpstream> create(JNIEnv* env, jobject upstream) {
        auto result = std::unique_ptr<JavaUpstream>(new JavaUpstream());
        env->GetJavaVM(&result->vm_);
        jclass cls = env->GetObjectClass(upstream);
        result->open_ = env->GetMethodID(cls, "open", "(J)J");
        result->read_ = env->GetMethodID(cls, "read", "([BI)I");
        result->close_ = env->GetMethodID(cls, "close", "()V");
        result->cancel_ = env->GetMethodID(cls, "cancel", "()V");
        result->etag_ = env->GetFieldID(cls, "etag", "Ljava/lang/String;");
        result->lastModified_ = env->GetFieldID(cls, "lastModified", "Ljava/lang/String;");
        result->error_ = env->GetFieldID(cls, "error", "Ljava/lang/String;");
        env->DeleteLocalRef(cls);
        jbyteArray buffer = env->NewByteArray(kBufferBytes);
        if (clearException(env) || !buffer || !result->open_ || !result->read_ || !result->close_ ||
            !result->cancel_ || !result->etag_ || !result->lastModified_ || !result->error_) {
            return nullptr;
        }
        result->object_ = env->NewGlobalRef(upstream);
        result->buffer_ = static_cast<jbyteArray>(env->NewGlobalRef(buffer));
        env->DeleteLocalRef(buffer);
        return result;
    }

    ~JavaUpstream() override {
        JNIEnv* env = threadEnv(vm_);
        if (!env) return;
        if (object_) env->DeleteGlobalRef(object_);
        if (buffer_) env->DeleteGlobalRef(buffer_);
    }

    bool open(int64_t position, rs_jni::SourceInfo& info, std::string& error) override {
        JNIEnv* env = threadEnv(vm_);
        if (!env) {
            error = "Cannot attach the reader's thread to Java";
            return false;
        }
        jlong size = env->CallLongMethod(object_, open_, static_cast<jlong>(position));
        if (clearException(env)) {
            error = "The data source threw";
            return false;
        }
        if (size == -2) {
            error = stringField(env, error_);
            return false;
        }
        info.size = size >= 0 ? size : -1;
        info.etag = stringField(env, etag_);
        info.lastModified = stringField(env, lastModified_);
        return true;
    }

    int64_t read(uint8_t* out, int64_t size, std::string& error) override {
        JNIEnv* env = threadEnv(vm_);
        if (!env) {
            error = "Cannot attach the reader's thread to Java";
            return -1;
        }
        jint n = env->CallIntMethod(object_, read_, buffer_, static_cast<jint>(std::min<int64_t>(size, kBufferBytes)));
        if (clearException(env)) {
            error = "The data source threw";
            return -1;
        }
        if (n < 0) {
            error = stringField(env, error_);
            return -1;
        }
        if (n > 0) env->GetByteArrayRegion(buffer_, 0, n, reinterpret_cast<jbyte*>(out));
        return n;
    }

    void close() override { call(close_); }
    void cancel() override { call(cancel_); }

private:
    static constexpr jint kBufferBytes = 64 * 1024;

    JavaUpstream() = default;

    void call(jmethodID method) {
        JNIEnv* env = threadEnv(vm_);
        if (!env) return;
        env->CallVoidMethod(object_, method);
        clearException(env);
    }

    std::string stringField(JNIEnv* env, jfieldID field) {
        auto value = static_cast<jstring>(env->GetObjectField(object_, field));
        std::string result = stringFromJava(env, value);
        if (value) env->DeleteLocalRef(value);
        return result;
    }

    JavaVM* vm_ = nullptr;
    jobject object_ = nullptr;
    jbyteArray buffer_ = nullptr;
    jmethodID open_ = nullptr, read_ = nullptr, close_ = nullptr, cancel_ = nullptr;
    jfieldID etag_ = nullptr, lastModified_ = nullptr, error_ = nullptr;
};

// Java holds a reference of its own to each store and reader, so each holder frees only its own.
using StoreRef = std::shared_ptr<rs_jni::Store>;
using ReaderRef = std::shared_ptr<rs_jni::RangeReader>;

const StoreRef& storeOf(jlong reference) {
    return *reinterpret_cast<StoreRef*>(reference);
}

const ReaderRef& readerOf(jlong reference) {
    return *reinterpret_cast<ReaderRef*>(reference);
}

jlong newStore(StoreRef store) {
    return store ? reinterpret_cast<jlong>(new StoreRef(std::move(store))) : 0;
}

// What a blocking read copies through before it lands in a Java array
constexpr int64_t kReadChunk = 256 * 1024;

} // namespace

extern "C" {

JNIEXPORT jlong JNICALL
Java_dev_mediacache_rangesource_RangeSource_nativePlugin(JNIEnv*, jclass) {
    return reinterpret_cast<jlong>(table());
}

JNIEXPORT jstring JNICALL
Java_dev_mediacache_rangesource_RangeSource_nativeVersion(JNIEnv* env, jclass) {
    return env->NewStringUTF(table()->version);
}

//==============================================================================
// RangeSourceStore
//==============================================================================

JNIEXPORT jlong JNICALL
Java_dev_mediacache_rangesource_RangeSourceStore_nativeDisk(JNIEnv* env, jclass, jstring dir, jlong maxBytes) {
    return newStore(rs_jni::Store::disk(table(), stringFromJava(env, dir), maxBytes));
}

JNIEXPORT jlong JNICALL
Java_dev_mediacache_rangesource_RangeSourceStore_nativeMemory(JNIEnv* env, jclass, jstring name, jlong maxBytes) {
    return newStore(rs_jni::Store::memory(table(), stringFromJava(env, name), maxBytes));
}

JNIEXPORT jlong JNICALL
Java_dev_mediacache_rangesource_RangeSourceStore_nativeRetain(JNIEnv*, jclass, jlong reference) {
    return reinterpret_cast<jlong>(new StoreRef(storeOf(reference)));
}

JNIEXPORT void JNICALL
Java_dev_mediacache_rangesource_RangeSourceStore_nativeRelease(JNIEnv*, jclass, jlong reference) {
    delete reinterpret_cast<StoreRef*>(reference);
}

JNIEXPORT jlong JNICALL
Java_dev_mediacache_rangesource_RangeSourceStore_nativeBytesUsed(JNIEnv*, jclass, jlong reference) {
    return storeOf(reference)->bytesUsed();
}

JNIEXPORT void JNICALL
Java_dev_mediacache_rangesource_RangeSourceStore_nativeSetMaxBytes(JNIEnv*, jclass, jlong reference, jlong maxBytes) {
    storeOf(reference)->setMaxBytes(maxBytes);
}

JNIEXPORT jint JNICALL
Java_dev_mediacache_rangesource_RangeSourceStore_nativeHolds(JNIEnv* env, jclass, jlong reference, jstring key) {
    return storeOf(reference)->holds(stringFromJava(env, key));
}

JNIEXPORT void JNICALL
Java_dev_mediacache_rangesource_RangeSourceStore_nativeRemove(JNIEnv* env, jclass, jlong reference, jstring key) {
    storeOf(reference)->remove(stringFromJava(env, key));
}

JNIEXPORT void JNICALL
Java_dev_mediacache_rangesource_RangeSourceStore_nativeClear(JNIEnv*, jclass, jlong reference) {
    storeOf(reference)->clear();
}

//==============================================================================
// RangeSourceReader
//==============================================================================

/**
 * @param store a reference from RangeSourceStore.nativeRetain, which this takes over; 0 for none
 * @param options blockSize, memoryBytes, readAheadBytes, reconnectGap, retries, retryDelayMs;
 *     negative for the defaults
 */
JNIEXPORT jlong JNICALL
Java_dev_mediacache_rangesource_RangeSourceReader_nativeOpen(JNIEnv* env, jclass, jobject upstream, jlong store,
                                                             jstring key, jlongArray options, jobjectArray errorOut) {
    StoreRef storeRef;
    if (store) {
        storeRef = storeOf(store);
        delete reinterpret_cast<StoreRef*>(store);
    }
    jlong o[6];
    env->GetLongArrayRegion(options, 0, 6, o);
    rs_jni::ReaderOptions readerOptions;
    readerOptions.blockSize = o[0];
    readerOptions.memoryBytes = o[1];
    readerOptions.readAheadBytes = o[2];
    readerOptions.reconnectGap = o[3];
    readerOptions.retries = static_cast<int>(o[4]);
    readerOptions.retryDelayMs = o[5];

    std::string error;
    ReaderRef reader;
    std::unique_ptr<JavaUpstream> javaUpstream = JavaUpstream::create(env, upstream);
    if (!javaUpstream) {
        error = "Cannot call the data source";
    } else {
        reader = rs_jni::RangeReader::open(table(), std::move(javaUpstream), storeRef, stringFromJava(env, key),
                                           readerOptions, error);
    }
    if (!reader) {
        jstring message = env->NewStringUTF(error.c_str());
        env->SetObjectArrayElement(errorOut, 0, message);
        env->DeleteLocalRef(message);
        return 0;
    }
    return reinterpret_cast<jlong>(new ReaderRef(std::move(reader)));
}

JNIEXPORT jlong JNICALL
Java_dev_mediacache_rangesource_RangeSourceReader_nativeRetain(JNIEnv*, jclass, jlong reference) {
    return reinterpret_cast<jlong>(new ReaderRef(readerOf(reference)));
}

JNIEXPORT void JNICALL
Java_dev_mediacache_rangesource_RangeSourceReader_nativeRelease(JNIEnv*, jclass, jlong reference) {
    delete reinterpret_cast<ReaderRef*>(reference);
}

JNIEXPORT void JNICALL
Java_dev_mediacache_rangesource_RangeSourceReader_nativeClose(JNIEnv*, jclass, jlong reference) {
    readerOf(reference)->close();
}

JNIEXPORT jlong JNICALL
Java_dev_mediacache_rangesource_RangeSourceReader_nativeSize(JNIEnv*, jclass, jlong reference) {
    return readerOf(reference)->size();
}

/** How many bytes were read, 0 at the end, -1 if they can't be fetched (with an IOException thrown). */
JNIEXPORT jint JNICALL
Java_dev_mediacache_rangesource_RangeSourceReader_nativeRead(JNIEnv* env, jclass, jlong reference, jlong position,
                                                             jbyteArray buffer, jint offset, jint length) {
    const ReaderRef& reader = readerOf(reference);
    std::vector<uint8_t> chunk(static_cast<size_t>(std::min<int64_t>(length, kReadChunk)));
    const int64_t n = reader->read(position, chunk.data(), static_cast<int64_t>(chunk.size()));
    if (n < 0) {
        throwIOException(env, reader->lastError());
        return -1;
    }
    if (n > 0) env->SetByteArrayRegion(buffer, offset, static_cast<jsize>(n), reinterpret_cast<const jbyte*>(chunk.data()));
    return static_cast<jint>(n);
}

/** nativeRead into a direct buffer, at `offset` in it. */
JNIEXPORT jint JNICALL
Java_dev_mediacache_rangesource_RangeSourceReader_nativeReadDirect(JNIEnv* env, jclass, jlong reference,
                                                                   jlong position, jobject buffer, jint offset,
                                                                   jint length) {
    const ReaderRef& reader = readerOf(reference);
    auto* base = static_cast<uint8_t*>(env->GetDirectBufferAddress(buffer));
    if (!base) {
        throwIOException(env, "Not a direct buffer");
        return -1;
    }
    const int64_t n = reader->read(position, base + offset, length);
    if (n < 0) {
        throwIOException(env, reader->lastError());
        return -1;
    }
    return static_cast<jint>(n);
}

/** read without waiting: RANGE_SOURCE_PENDING while the bytes are on their way, -1 once if fetching them failed. */
JNIEXPORT jint JNICALL
Java_dev_mediacache_rangesource_RangeSourceReader_nativeTryRead(JNIEnv* env, jclass, jlong reference, jlong position,
                                                                jbyteArray buffer, jint offset, jint length) {
    if (length <= 0) return 0;
    jbyte* bytes = static_cast<jbyte*>(env->GetPrimitiveArrayCritical(buffer, nullptr));
    if (!bytes) return -1;
    const int64_t n = readerOf(reference)->tryRead(position, reinterpret_cast<uint8_t*>(bytes) + offset, length);
    env->ReleasePrimitiveArrayCritical(buffer, bytes, n > 0 ? 0 : JNI_ABORT);
    return static_cast<jint>(n);
}

/** Null once the whole file is held, else why not. */
JNIEXPORT jstring JNICALL
Java_dev_mediacache_rangesource_RangeSourceReader_nativeFetchAll(JNIEnv* env, jclass, jlong reference) {
    const ReaderRef& reader = readerOf(reference);
    if (reader->fetchAll()) return nullptr;
    const std::string error = reader->lastError();
    return env->NewStringUTF(error.empty() ? "Reading the file failed" : error.c_str());
}

JNIEXPORT jstring JNICALL
Java_dev_mediacache_rangesource_RangeSourceReader_nativeLastError(JNIEnv* env, jclass, jlong reference) {
    return env->NewStringUTF(readerOf(reference)->lastError().c_str());
}

/** Fills `out` with opens and bytesFetched. */
JNIEXPORT void JNICALL
Java_dev_mediacache_rangesource_RangeSourceReader_nativeStats(JNIEnv* env, jclass, jlong reference, jlongArray out) {
    const rs_jni::RangeReader::Stats stats = readerOf(reference)->stats();
    const jlong values[2] = {stats.opens, stats.bytesFetched};
    env->SetLongArrayRegion(out, 0, 2, values);
}

} // extern "C"
