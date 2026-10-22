package dev.mediacache.rangesource;

import android.net.Uri;

import java.io.IOException;

/**
 * range-source on Android: range streaming and storage for code that reads files by offset.
 *
 * <pre>
 * RangeSourceStore store = RangeSourceStore.disk(new File(context.getCacheDir(), "my-player"), 512L &lt;&lt; 20);
 * try (RangeSourceReader reader = RangeSource.open("https://example.com/clip.bin", store)) {
 *     int n = reader.read(position, buffer, 0, buffer.length);
 * }
 * </pre>
 *
 * Players built on its native code (alpha-video, alpha-video-gpu) find this class by name and
 * read through {@link #plugin()}, its C table; an app that includes the dependency has nothing to
 * call.
 */
public final class RangeSource {

    static {
        System.loadLibrary("rangesource");
    }

    private RangeSource() {}

    /**
     * The address of the native table, {@code const RangeSourcePlugin*} (range_source.h), for
     * native code that reads through it.
     */
    public static long plugin() {
        return nativePlugin();
    }

    /** The add-on's version, such as "1.0.0". */
    public static String version() {
        return nativeVersion();
    }

    /** Opens {@code url} with {@link RangeHttpDataSource}, stored under the URL; {@code store} may be null. */
    public static RangeSourceReader open(String url, RangeSourceStore store) throws IOException {
        return RangeSourceReader.open(new RangeHttpDataSource(), Uri.parse(url), store, url, null);
    }

    /** Opens {@code uri} through {@code source}, stored under the URI; {@code store} may be null. */
    public static RangeSourceReader open(Uri uri, RangeDataSource source, RangeSourceStore store) throws IOException {
        return RangeSourceReader.open(source, uri, store, uri.toString(), null);
    }

    private static native long nativePlugin();
    private static native String nativeVersion();
}
