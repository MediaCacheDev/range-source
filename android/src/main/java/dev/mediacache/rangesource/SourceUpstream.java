package dev.mediacache.rangesource;

import android.net.Uri;

import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * A {@link RangeDataSource} as the native reader calls it, on the reader's fetch thread, with
 * failures as return values.
 */
final class SourceUpstream {
    // cancel() comes from whichever thread closes the reader, the main thread too, and an HTTPS
    // disconnect can write to the socket.
    private static final ExecutorService cancelExecutor = Executors.newCachedThreadPool(r -> {
        Thread t = new Thread(r, "RangeSourceCancel");
        t.setDaemon(true);
        return t;
    });

    private final RangeDataSource source;
    private final Uri uri;
    private final Map<String, String> headers;
    // Read by native code after open() and failures
    String etag;
    String lastModified;
    String error;

    SourceUpstream(RangeDataSource source, Uri uri, Map<String, String> headers) {
        this.source = source;
        this.uri = uri;
        this.headers = headers;
    }

    /** The file's size, -1 if not known, or -2 with {@link #error} set. */
    long open(long position) {
        try {
            RangeDataSource.Info info = source.open(uri, position, headers);
            etag = info.etag;
            lastModified = info.lastModified;
            return info.size;
        } catch (Exception e) {
            error = describe(e);
            return -2;
        }
    }

    /** How many bytes were read into {@code buffer}, 0 at the end, or -1 with {@link #error} set. */
    int read(byte[] buffer, int length) {
        try {
            int n;
            do {
                n = source.read(buffer, 0, length);
            } while (n == 0);
            return n < 0 ? 0 : n;
        } catch (Exception e) {
            error = describe(e);
            return -1;
        }
    }

    void close() {
        try {
            source.close();
        } catch (Exception ignored) {
        }
    }

    void cancel() {
        cancelExecutor.execute(() -> {
            try {
                source.cancel();
            } catch (Exception ignored) {
            }
        });
    }

    private static String describe(Exception e) {
        return e.getMessage() != null ? e.getMessage() : e.toString();
    }
}
