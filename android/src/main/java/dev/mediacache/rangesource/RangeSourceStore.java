package dev.mediacache.rangesource;

import java.io.Closeable;
import java.io.File;
import java.io.IOException;

/**
 * Keeps files' bytes between plays, in blocks, under a byte cap shared by every key in it; the
 * least recently used keys go first. On disk, each key is a sparse data file and a small meta file
 * in one folder. A store is partial: it keeps what has been read, and a file held whole is read
 * again without the network.
 *
 * One store per folder (or name, in memory) in the process: opening it again gets the same store,
 * with the new cap. Thread-safe.
 */
public final class RangeSourceStore implements Closeable {

    static {
        System.loadLibrary("rangesource");
    }

    /** How much of a key a store holds. */
    public enum Holds { NONE, PART, WHOLE }

    // Guarded by this; 0 once closed
    private long handle;

    private RangeSourceStore(long handle) {
        this.handle = handle;
    }

    /**
     * The store in folder {@code dir}, created if needed, such as
     * {@code new File(context.getCacheDir(), "my-player")}.
     *
     * @throws IOException if the folder can't be created
     */
    public static RangeSourceStore disk(File dir, long maxBytes) throws IOException {
        long handle = nativeDisk(dir.getPath(), maxBytes);
        if (handle == 0) throw new IOException("Cannot create a store in " + dir);
        return new RangeSourceStore(handle);
    }

    /** A store in memory, for the process's lifetime, under {@code name}. */
    public static RangeSourceStore memory(String name, long maxBytes) {
        return new RangeSourceStore(nativeMemory(name, maxBytes));
    }

    public synchronized long bytesUsed() {
        return nativeBytesUsed(checked());
    }

    public synchronized void setMaxBytes(long maxBytes) {
        nativeSetMaxBytes(checked(), maxBytes);
    }

    public synchronized Holds holds(String key) {
        return Holds.values()[nativeHolds(checked(), key)];
    }

    public synchronized void remove(String key) {
        nativeRemove(checked(), key);
    }

    /** Removes every key. */
    public synchronized void clear() {
        nativeClear(checked());
    }

    /** Drops this object's hold on the store; readers opened with it keep it until they close. */
    @Override
    public synchronized void close() {
        if (handle != 0) nativeRelease(handle);
        handle = 0;
    }

    /** A native reference for a reader to take over. */
    synchronized long retain() {
        return nativeRetain(checked());
    }

    private long checked() {
        if (handle == 0) throw new IllegalStateException("The store is closed");
        return handle;
    }

    private static native long nativeDisk(String dir, long maxBytes);
    private static native long nativeMemory(String name, long maxBytes);
    private static native long nativeRetain(long reference);
    private static native void nativeRelease(long reference);
    private static native long nativeBytesUsed(long reference);
    private static native void nativeSetMaxBytes(long reference, long maxBytes);
    private static native int nativeHolds(long reference, String key);
    private static native void nativeRemove(long reference, String key);
    private static native void nativeClear(long reference);
}
