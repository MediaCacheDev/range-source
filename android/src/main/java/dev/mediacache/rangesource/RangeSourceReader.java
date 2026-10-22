package dev.mediacache.rangesource;

import android.net.Uri;

import java.io.Closeable;
import java.io.IOException;
import java.io.InputStream;
import java.nio.ByteBuffer;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * Reads a file by offset from a {@link RangeDataSource}, through blocks in memory and an optional
 * {@link RangeSourceStore}, for code that reads where it likes: a demuxer, a decoder, an asset
 * loader. One fetch thread keeps one read open on the source and moves it only when a read needs
 * bytes far from it, so reading from the start is one request, and a seek one more. After each read
 * it fetches ahead in the background, and retries a failed read.
 *
 * Thread-safe. {@link #close} from any thread makes reads in progress fail.
 */
public final class RangeSourceReader implements Closeable {

    static {
        System.loadLibrary("rangesource");
    }

    /** What {@link #tryRead} returns while the bytes are on their way. */
    public static final int PENDING = -2;

    /** How a reader fetches; a field left negative takes the default. */
    public static final class Options {
        private final Map<String, String> headers = new LinkedHashMap<>();
        private long blockSize = -1;
        private long memoryBytes = -1;
        private long readAheadBytes = -1;
        private long reconnectGap = -1;
        private long retries = -1;
        private long retryDelayMs = -1;

        /** Sent with every request, for sources that make HTTP requests. */
        public Options setHeader(String name, String value) {
            headers.put(name, value);
            return this;
        }

        public Options setHeaders(Map<String, String> headers) {
            this.headers.clear();
            if (headers != null) this.headers.putAll(headers);
            return this;
        }

        /** Block size in bytes; 256 KB by default. A stored copy keeps the size it was written with. */
        public Options setBlockSize(long blockSize) {
            this.blockSize = blockSize;
            return this;
        }

        /** Bytes of blocks kept in memory, least recently used out; 16 MB by default. */
        public Options setMemoryBytes(long memoryBytes) {
            this.memoryBytes = memoryBytes;
            return this;
        }

        /** Fetched past each read in the background; 2 MB by default, 0 for none. */
        public Options setReadAheadBytes(long readAheadBytes) {
            this.readAheadBytes = readAheadBytes;
            return this;
        }

        /** A fetch this far past the open read reads on through rather than reconnect; 512 KB by default. */
        public Options setReconnectGap(long reconnectGap) {
            this.reconnectGap = reconnectGap;
            return this;
        }

        /** Attempts after a failed open or read, each after twice the delay of the one before; 3 and 500 ms by default. */
        public Options setRetries(int retries, long retryDelayMs) {
            this.retries = retries;
            this.retryDelayMs = retryDelayMs;
            return this;
        }

        long[] values() {
            return new long[] {blockSize, memoryBytes, readAheadBytes, reconnectGap, retries, retryDelayMs};
        }
    }

    /** What a reader has fetched. */
    public static final class Stats {
        /** Reads opened on the source, the first included */
        public final long opens;
        /** Bytes read from the source */
        public final long bytesFetched;

        Stats(long opens, long bytesFetched) {
            this.opens = opens;
            this.bytesFetched = bytesFetched;
        }
    }

    // Guarded by this; 0 once closed
    private long handle;
    private final String description;

    private RangeSourceReader(long handle, String description) {
        this.handle = handle;
        this.description = description;
    }

    /**
     * Opens a reader over {@code source}. Opens the source at 0 to learn the file's size and
     * version, unless the store holds the file whole; blocks for that.
     *
     * @param store where blocks are kept between plays, and read from first; null for none
     * @param key what the store calls this file, such as its URL; ignored without a store
     * @param options null for the defaults
     * @throws IOException if the source can't be opened
     */
    public static RangeSourceReader open(RangeDataSource source, Uri uri, RangeSourceStore store, String key,
                                         Options options) throws IOException {
        Options o = options != null ? options : new Options();
        Map<String, String> headers = o.headers.isEmpty()
            ? Collections.emptyMap() : Collections.unmodifiableMap(new LinkedHashMap<>(o.headers));
        String[] error = new String[1];
        long storeReference = store != null ? store.retain() : 0;
        long handle = nativeOpen(new SourceUpstream(source, uri, headers), storeReference,
            key != null ? key : uri.toString(), o.values(), error);
        if (handle == 0) throw new IOException(error[0] != null ? error[0] : "Cannot open " + uri);
        return new RangeSourceReader(handle, uri.toString());
    }

    /** The file's size, or -1 while it isn't known. */
    public long size() {
        long reference = retain();
        if (reference == 0) return -1;
        try {
            return nativeSize(reference);
        } finally {
            nativeRelease(reference);
        }
    }

    /**
     * Reads up to {@code length} bytes at {@code position}, waiting for them: fewer at a block's
     * end, -1 at or past the end of the file.
     *
     * @throws IOException if they can't be fetched, or the reader is closed
     */
    public int read(long position, byte[] buffer, int offset, int length) throws IOException {
        if (offset < 0 || length < 0 || offset + length > buffer.length) throw new IndexOutOfBoundsException();
        if (length == 0) return 0;
        long reference = retained();
        try {
            int n = nativeRead(reference, position, buffer, offset, length);
            return n == 0 ? -1 : n;
        } finally {
            nativeRelease(reference);
        }
    }

    /**
     * Reads into {@code buffer}'s remaining space at {@code position}, and advances the buffer's
     * position: fewer at a block's end, -1 at or past the end of the file. A direct buffer is
     * filled in place.
     */
    public int read(long position, ByteBuffer buffer) throws IOException {
        int length = buffer.remaining();
        if (length == 0) return 0;
        int n;
        if (buffer.isDirect()) {
            long reference = retained();
            try {
                n = nativeReadDirect(reference, position, buffer, buffer.position(), length);
            } finally {
                nativeRelease(reference);
            }
            if (n == 0) return -1;
        } else if (buffer.hasArray()) {
            n = read(position, buffer.array(), buffer.arrayOffset() + buffer.position(), length);
            if (n < 0) return -1;
        } else {
            byte[] scratch = new byte[length];
            n = read(position, scratch, 0, length);
            if (n < 0) return -1;
            buffer.duplicate().put(scratch, 0, n);
        }
        buffer.position(buffer.position() + n);
        return n;
    }

    /**
     * Reads what's held at {@code position} without waiting, for a caller that must not block, such
     * as a render loop: how many bytes, -1 at the end of the file, or {@link #PENDING}, having
     * asked for them, so a later call finds them.
     *
     * @throws IOException once, if fetching them failed; the call after that asks again
     */
    public int tryRead(long position, byte[] buffer, int offset, int length) throws IOException {
        if (offset < 0 || length < 0 || offset + length > buffer.length) throw new IndexOutOfBoundsException();
        long reference = retained();
        try {
            int n = nativeTryRead(reference, position, buffer, offset, length);
            if (n == PENDING) return PENDING;
            if (n < 0) throw new IOException("Reading " + description + " failed: " + nativeLastError(reference));
            return n == 0 && length > 0 ? -1 : n;
        } finally {
            nativeRelease(reference);
        }
    }

    /** Reads the whole file, so that the store holds it. Blocks. */
    public void fetchAll() throws IOException {
        long reference = retained();
        try {
            String error = nativeFetchAll(reference);
            if (error != null) throw new IOException(error);
        } finally {
            nativeRelease(reference);
        }
    }

    /**
     * The file from {@code position} on, as a stream reading through this reader. Closing the stream
     * leaves the reader open.
     */
    public InputStream inputStream(long position) {
        return new InputStream() {
            private long next = position;

            @Override
            public int read() throws IOException {
                byte[] one = new byte[1];
                return read(one, 0, 1) < 0 ? -1 : one[0] & 0xff;
            }

            @Override
            public int read(byte[] buffer, int offset, int length) throws IOException {
                if (length == 0) return 0;
                int n = RangeSourceReader.this.read(next, buffer, offset, length);
                if (n > 0) next += n;
                return n;
            }

            @Override
            public long skip(long count) {
                if (count <= 0) return 0;
                long size = size();
                long skipped = size >= 0 ? Math.max(0, Math.min(count, size - next)) : count;
                next += skipped;
                return skipped;
            }
        };
    }

    public Stats stats() {
        long reference = retain();
        if (reference == 0) return new Stats(0, 0);
        try {
            long[] values = new long[2];
            nativeStats(reference, values);
            return new Stats(values[0], values[1]);
        } finally {
            nativeRelease(reference);
        }
    }

    /** Fails reads in progress and later ones, and stops fetching. */
    @Override
    public void close() {
        long h;
        synchronized (this) {
            h = handle;
            handle = 0;
        }
        if (h == 0) return;
        nativeClose(h);
        nativeRelease(h);
    }

    @Override
    public String toString() {
        return description;
    }

    // A reference of a call's own, so that close() never frees the reader under it; 0 once closed
    private synchronized long retain() {
        return handle != 0 ? nativeRetain(handle) : 0;
    }

    private long retained() throws IOException {
        long reference = retain();
        if (reference == 0) throw new IOException("The reader is closed");
        return reference;
    }

    private static native long nativeOpen(SourceUpstream upstream, long store, String key, long[] options,
                                          String[] error);
    private static native long nativeRetain(long reference);
    private static native void nativeRelease(long reference);
    private static native void nativeClose(long reference);
    private static native long nativeSize(long reference);
    private static native int nativeRead(long reference, long position, byte[] buffer, int offset, int length);
    private static native int nativeReadDirect(long reference, long position, ByteBuffer buffer, int offset,
                                               int length);
    private static native int nativeTryRead(long reference, long position, byte[] buffer, int offset, int length);
    private static native String nativeFetchAll(long reference);
    private static native String nativeLastError(long reference);
    private static native void nativeStats(long reference, long[] out);
}
