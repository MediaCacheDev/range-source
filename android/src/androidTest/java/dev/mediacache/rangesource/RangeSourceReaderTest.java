package dev.mediacache.rangesource;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotEquals;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import android.net.Uri;

import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;

import org.junit.Test;
import org.junit.runner.RunWith;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.IOException;
import java.io.InputStream;
import java.nio.ByteBuffer;
import java.util.Arrays;
import java.util.Map;
import java.util.Random;
import java.util.concurrent.atomic.AtomicInteger;

/** The Java API over the native reader and stores, with a data source in memory. */
@RunWith(AndroidJUnit4.class)
public class RangeSourceReaderTest {

    private static final int SIZE = 3 * 1024 * 1024 + 123;
    private static final Uri URI = Uri.parse("test://clip");

    private static byte[] bytes(int size, long seed) {
        byte[] data = new byte[size];
        new Random(seed).nextBytes(data);
        return data;
    }

    /** Serves a byte array from any position; counts opens. */
    private static final class MemorySource implements RangeDataSource {
        final byte[] data;
        final AtomicInteger opens;
        private int position = -1;

        MemorySource(byte[] data, AtomicInteger opens) {
            this.data = data;
            this.opens = opens;
        }

        @Override
        public Info open(Uri uri, long at, Map<String, String> headers) {
            opens.incrementAndGet();
            position = (int) Math.min(at, data.length);
            return new Info(data.length, "v1", null);
        }

        @Override
        public int read(byte[] buffer, int offset, int length) {
            if (position >= data.length) return -1;
            int n = Math.min(length, data.length - position);
            System.arraycopy(data, position, buffer, offset, n);
            position += n;
            return n;
        }

        @Override
        public void close() {
            position = -1;
        }
    }

    private static byte[] readAll(RangeSourceReader reader) throws IOException {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] buffer = new byte[100_000];
        long position = 0;
        int n;
        while ((n = reader.read(position, buffer, 0, buffer.length)) > 0) {
            out.write(buffer, 0, n);
            position += n;
        }
        return out.toByteArray();
    }

    private static File freshDir(String name) {
        File dir = new File(InstrumentationRegistry.getInstrumentation().getTargetContext().getCacheDir(), name);
        File[] files = dir.listFiles();
        if (files != null) for (File f : files) f.delete();
        return dir;
    }

    @Test
    public void readsInOrderAndSeeks() throws IOException {
        byte[] data = bytes(SIZE, 1);
        AtomicInteger opens = new AtomicInteger();
        try (RangeSourceReader reader = RangeSource.open(URI, new MemorySource(data, opens), null)) {
            assertEquals(SIZE, reader.size());
            assertArrayEquals(data, readAll(reader));

            // Across the last block boundary: a read stops at a block's end
            byte[] tail = new byte[1000];
            int total = 0;
            int n;
            while ((n = reader.read(SIZE - 500 + total, tail, total, tail.length - total)) > 0) total += n;
            assertEquals(500, total);
            assertArrayEquals(Arrays.copyOfRange(data, SIZE - 500, SIZE), Arrays.copyOf(tail, 500));
            assertEquals(-1, reader.read(SIZE, tail, 0, tail.length));
        }
    }

    @Test
    public void storeServesTheSecondReadWithoutTheSource() throws IOException {
        byte[] data = bytes(SIZE, 2);
        AtomicInteger opens = new AtomicInteger();
        try (RangeSourceStore store = RangeSourceStore.disk(freshDir("rs-test-store"), 64L << 20)) {
            try (RangeSourceReader reader = RangeSource.open(URI, new MemorySource(data, opens), store)) {
                reader.fetchAll();
            }
            assertEquals(RangeSourceStore.Holds.WHOLE, store.holds(URI.toString()));
            assertTrue(store.bytesUsed() >= SIZE);

            int before = opens.get();
            try (RangeSourceReader reader = RangeSource.open(URI, new MemorySource(data, opens), store)) {
                assertArrayEquals(data, readAll(reader));
                assertEquals(0, reader.stats().opens);
            }
            assertEquals(before, opens.get());

            store.remove(URI.toString());
            assertEquals(RangeSourceStore.Holds.NONE, store.holds(URI.toString()));
        }
    }

    @Test
    public void tryReadIsPendingThenHasTheBytes() throws IOException, InterruptedException {
        byte[] data = bytes(SIZE, 3);
        RangeSourceReader.Options options = new RangeSourceReader.Options().setReadAheadBytes(0);
        try (RangeSourceReader reader = RangeSourceReader.open(new MemorySource(data, new AtomicInteger()), URI, null,
                null, options)) {
            byte[] buffer = new byte[4096];
            long position = 2_000_000;
            int n = reader.tryRead(position, buffer, 0, buffer.length);
            for (int i = 0; n == RangeSourceReader.PENDING && i < 500; i++) {
                Thread.sleep(4);
                n = reader.tryRead(position, buffer, 0, buffer.length);
            }
            assertTrue(n > 0);
            assertArrayEquals(Arrays.copyOfRange(data, (int) position, (int) position + n), Arrays.copyOf(buffer, n));
        }
    }

    @Test
    public void inputStreamAndDirectBuffers() throws IOException {
        byte[] data = bytes(SIZE, 4);
        try (RangeSourceReader reader = RangeSource.open(URI, new MemorySource(data, new AtomicInteger()), null)) {
            InputStream in = reader.inputStream(1000);
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buffer = new byte[65536];
            int n;
            while ((n = in.read(buffer)) > 0) out.write(buffer, 0, n);
            assertArrayEquals(Arrays.copyOfRange(data, 1000, SIZE), out.toByteArray());

            ByteBuffer direct = ByteBuffer.allocateDirect(SIZE);
            while (direct.hasRemaining()) {
                if (reader.read(direct.position(), direct) < 0) break;
            }
            direct.flip();
            byte[] copy = new byte[direct.remaining()];
            direct.get(copy);
            assertArrayEquals(data, copy);
        }
    }

    @Test
    public void closeFailsLaterReads() throws IOException {
        RangeSourceReader reader = RangeSource.open(URI, new MemorySource(bytes(1000, 5), new AtomicInteger()), null);
        reader.close();
        try {
            reader.read(0, new byte[10], 0, 10);
            fail("read after close");
        } catch (IOException expected) {
        }
    }

    @Test
    public void openFailsWithTheSourcesError() {
        RangeDataSource failing = new RangeDataSource() {
            @Override
            public Info open(Uri uri, long position, Map<String, String> headers) throws IOException {
                throw new IOException("HTTP 404 for " + uri);
            }

            @Override
            public int read(byte[] buffer, int offset, int length) {
                return -1;
            }

            @Override
            public void close() {}
        };
        RangeSourceReader.Options options = new RangeSourceReader.Options().setRetries(0, 0);
        try {
            RangeSourceReader.open(failing, URI, null, null, options).close();
            fail("opened");
        } catch (IOException e) {
            assertTrue(e.getMessage(), e.getMessage().contains("404"));
        }
    }

    @Test
    public void tableIsThere() {
        assertNotEquals(0, RangeSource.plugin());
        assertEquals("1.0.0", RangeSource.version());
    }
}
