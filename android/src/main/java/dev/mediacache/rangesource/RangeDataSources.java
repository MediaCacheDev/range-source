package dev.mediacache.rangesource;

import java.util.HashMap;
import java.util.Map;

/**
 * Data sources by name, for players that take a source's name, such as React Native's
 * {@code source={{ uri, dataSource: 'name' }}}: register a factory here, and every player that
 * reads through range-source finds it. Thread-safe.
 */
public final class RangeDataSources {

    private static final Map<String, RangeDataSource.Factory> factories = new HashMap<>();

    private RangeDataSources() {}

    /** Registers {@code factory} under {@code name}, replacing any registered before. */
    public static synchronized void register(String name, RangeDataSource.Factory factory) {
        factories.put(name, factory);
    }

    public static synchronized void unregister(String name) {
        factories.remove(name);
    }

    /** The factory registered under {@code name}, or null. */
    public static synchronized RangeDataSource.Factory get(String name) {
        return factories.get(name);
    }
}
