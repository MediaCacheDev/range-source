import Foundation
import RangeSource
import XCTest

/** Serves `bytes` from memory, counting reads; optionally late, or failing. */
final class MemorySource: NSObject, RangeDataSource {
    let bytes: Data
    var delay: TimeInterval = 0
    var failure: String?
    private let lock = NSLock()
    private var count = 0

    init(_ bytes: Data) {
        self.bytes = bytes
    }

    var reads: Int {
        lock.lock()
        defer { lock.unlock() }
        return count
    }

    func read(
        url: URL, offset: Int64, length: Int64, headers: [String: String],
        response: @escaping (RangeDataInfo) -> Void, data: @escaping (Data) -> Void,
        completion: @escaping (Error?) -> Void
    ) -> RangeCancellable {
        lock.lock()
        count += 1
        lock.unlock()
        let token = Token()
        DispatchQueue.global().asyncAfter(deadline: .now() + delay) { [bytes, failure] in
            if token.cancelled { return }
            if let failure {
                completion(NSError(domain: "test", code: 1, userInfo: [NSLocalizedDescriptionKey: failure]))
                return
            }
            response(RangeDataInfo(size: Int64(bytes.count), etag: "v1", lastModified: nil))
            let start = Int(min(offset, Int64(bytes.count)))
            let end = Int(min(offset + length, Int64(bytes.count)))
            data(bytes.subdata(in: start..<end))
            completion(nil)
        }
        return token
    }

    final class Token: NSObject, RangeCancellable {
        private(set) var cancelled = false
        func cancel() { cancelled = true }
    }
}

final class RangeSourceTests: XCTestCase {
    let url = URL(string: "test://clip")!
    let bytes = Data((0..<3_000_000).map { UInt8(truncatingIfNeeded: $0 &* 31 &+ $0 >> 8) })

    /** Reads `length` bytes at `position`, across blocks. */
    func readFully(_ reader: RangeSourceReader, at position: Int64, length: Int) throws -> Data {
        var result = Data()
        while result.count < length {
            let chunk = try reader.readData(at: position + Int64(result.count), length: length - result.count)
            if chunk.isEmpty { break }
            result.append(chunk)
        }
        return result
    }

    func testReadsInOrderAndSeeks() throws {
        let source = MemorySource(bytes)
        let reader = try RangeSourceReader.open(url: url, dataSource: source, store: nil, key: nil, options: nil)
        XCTAssertEqual(reader.size, Int64(bytes.count))
        XCTAssertEqual(try readFully(reader, at: 0, length: 100_000), bytes.prefix(100_000))
        let tail = Int64(bytes.count - 500)
        XCTAssertEqual(try readFully(reader, at: tail, length: 1000), bytes.suffix(500))
        XCTAssertEqual(try reader.readData(at: Int64(bytes.count), length: 10).count, 0)
    }

    func testStoreServesTheSecondReadWithoutTheSource() throws {
        let store = RangeSourceStore.memory(name: "tests-\(UUID().uuidString)", maxBytes: 64 << 20)
        let first = MemorySource(bytes)
        let reader = try RangeSourceReader.open(url: url, dataSource: first, store: store, key: "clip", options: nil)
        try reader.fetchAll()
        reader.close()
        XCTAssertEqual(store.holds(key: "clip"), .whole)

        let second = MemorySource(bytes)
        let again = try RangeSourceReader.open(url: url, dataSource: second, store: store, key: "clip", options: nil)
        XCTAssertEqual(try readFully(again, at: 1_000_000, length: 300_000), bytes.subdata(in: 1_000_000..<1_300_000))
        XCTAssertEqual(second.reads, 0)
        XCTAssertGreaterThan(store.bytesUsed, 0)
        store.remove(key: "clip")
        XCTAssertEqual(store.holds(key: "clip"), .none)
    }

    func testTryReadIsPendingThenHasTheBytes() throws {
        let source = MemorySource(bytes)
        let reader = try RangeSourceReader.open(url: url, dataSource: source, store: nil, key: nil, options: nil)
        source.delay = 0.3
        var buffer = [UInt8](repeating: 0, count: 1000)
        let far: Int64 = 2_500_000
        XCTAssertEqual(reader.tryRead(at: far, into: &buffer, length: buffer.count), RangeSourcePending)
        let deadline = Date(timeIntervalSinceNow: 10)
        var n = RangeSourcePending
        while n == RangeSourcePending && Date() < deadline {
            Thread.sleep(forTimeInterval: 0.02)
            n = reader.tryRead(at: far, into: &buffer, length: buffer.count)
        }
        XCTAssertEqual(n, buffer.count)
        XCTAssertEqual(Data(buffer), bytes.subdata(in: Int(far)..<Int(far) + buffer.count))
    }

    func testCloseFailsLaterReads() throws {
        let reader = try RangeSourceReader.open(url: url, dataSource: MemorySource(bytes), store: nil, key: nil, options: nil)
        reader.close()
        var buffer = [UInt8](repeating: 0, count: 10)
        XCTAssertEqual(reader.read(at: 0, into: &buffer, length: buffer.count), -1)
    }

    func testOpenFailsWithTheSourcesError() {
        let source = MemorySource(bytes)
        source.failure = "no such clip"
        let options = RangeSourceReaderOptions()
        options.retries = 0
        XCTAssertThrowsError(try RangeSourceReader.open(url: url, dataSource: source, store: nil, key: nil, options: options)) {
            XCTAssertTrue($0.localizedDescription.contains("no such clip"), $0.localizedDescription)
        }
    }

    func testReadsAFileURLWithURLSession() throws {
        let file = FileManager.default.temporaryDirectory.appendingPathComponent("range-source-\(UUID().uuidString)")
        try bytes.write(to: file)
        defer { try? FileManager.default.removeItem(at: file) }
        let reader = try RangeSource.open(url: file, store: nil)
        XCTAssertEqual(reader.size, Int64(bytes.count))
        XCTAssertEqual(try readFully(reader, at: 2_000_000, length: 50_000), bytes.subdata(in: 2_000_000..<2_050_000))
    }

    func testTableAndDataSourcesForPlayers() {
        XCTAssertNotNil(RangeSource.plugin)
        XCTAssertEqual(RangeSource.versionString, "1.0.0")
        RangeDataSources.register(MemorySource(bytes), name: "memory")
        XCTAssertNotNil(RangeDataSources.dataSource(named: "memory"))
        RangeDataSources.unregister(name: "memory")
        XCTAssertNil(RangeDataSources.dataSource(named: "memory"))
        var upstream = [UInt8](repeating: 0, count: 256)
        XCTAssertFalse(RangeSource.getUpstream(&upstream, forDataSourceNamed: "missing", url: url, headers: [:]))
    }
}
