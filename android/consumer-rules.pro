# Players find the add-on by name and ask it for its native table
-keep class dev.mediacache.rangesource.RangeSource {
    public static long plugin();
    public static java.lang.String version();
}

# Called from native code
-keep class dev.mediacache.rangesource.SourceUpstream {
    long open(long);
    int read(byte[], int);
    void close();
    void cancel();
    java.lang.String etag;
    java.lang.String lastModified;
    java.lang.String error;
}
