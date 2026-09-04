import Combine
import SwiftUI
import UserNotifications

struct Account: Decodable, Identifiable {
    let account: String
    let org: String
    let email: String?
    let orgName: String?
    let label: String
    let active: Bool?
    let sessions: Int
    let activeAt: Double?
    let pending: String?
    let pendingFailures: [Failure]?
    var id: String { account + "/" + org }
    var selector: String { account + " " + org }
    var name: String { email ?? String(account.prefix(8)) }
    var plan: String { orgName ?? String(org.prefix(8)) }
}

struct Config: Decodable {
    let node: String
    let script: String
}

struct Failure: Decodable {
    let id: String?
    let title: String?
    let error: String
}

struct Problem: Decodable {
    let id: String?
    let title: String?
    let check: String
}

struct Reconciliation: Decodable {
    let title: String
    let error: String
}

struct Event: Decodable {
    let stage: String?
    let text: String?
    let live: Bool?
    let completed: Int?
    let total: Int?
    let done: Bool?
    let ok: Bool?
    let complete: Bool?
    let moved: Int?
    let rescued: Int?
    let cloudArchived: Int?
    let cloudChecked: Int?
    let cloudRestored: Int?
    let newerCloud: Int?
    let keptLocal: Int?
    let pendingCloud: Int?
    let pendingUndo: [String]?
    let retired: Int?
    let failed: [Failure]?
    let problems: [Problem]?
    let note: String?
    let restart: Bool?
    let reconciled: Reconciliation?
    let retry: Bool?
    let undone: String?
    let sessions: Int?
    let restored: Int?
    let refused: [String]?
    let reason: String?
    let nothing: Bool?
}

extension String {
    var sentence: String { prefix(1).uppercased() + dropFirst() }
}

@MainActor
final class Model: ObservableObject {
    @Published var accounts: [Account] = []
    @Published var from: Set<String> = []
    @Published var to: String?
    @Published var excluded: Set<String> = []
    @Published var lanes: [String: String] = [:]
    @Published var lines: [(String, String)] = []
    @Published var note = ""
    @Published var badge = ""
    @Published var symbol = "arrow.left.arrow.right"
    @Published var running = false
    @Published var restartAvailable = false
    @Published var progressCompleted: Int?
    @Published var progressTotal: Int?
    let snapshot: Bool
    let demo: Bool
    private let config: Config?
    private var refreshing = false
    private var pendingResult = false

    init(snapshot: Bool = false) {
        self.snapshot = snapshot
        demo = false
        let file = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support/claude-transplant/menubar.json")
        config = (try? Data(contentsOf: file)).flatMap { try? JSONDecoder().decode(Config.self, from: $0) }
        if snapshot {
            if let config {
                let text = Model.capture(node(config.node), [config.script, "accounts", "--json"])
                accounts = (try? JSONDecoder().decode([Account].self, from: Data(text.utf8))) ?? []
            }
            settle()
            return
        }
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound]) { _, _ in }
        refresh()
    }

    init(demo accounts: [Account]) {
        snapshot = true
        demo = true
        config = nil
        self.accounts = accounts
        settle()
    }

    var pendingAccounts: [Account] { accounts.filter { $0.pending != nil } }
    var activePendingAccount: Account? { pendingAccounts.first { $0.active == true } }
    var canKeepLocal: Bool { !running && pendingAccounts.contains { $0.pending == "cloud" } }
    var pendingReady: Bool { !running && activePendingAccount != nil && (config != nil || demo) }
    var ready: Bool { !running && pendingAccounts.isEmpty && !from.isEmpty && to != nil && (config != nil || demo) }
    var pendingPrompt: String {
        guard !pendingAccounts.isEmpty else { return "" }
        let labels = pendingAccounts.map(\.label).joined(separator: " or ")
        let failures = activePendingAccount?.pendingFailures ?? []
        if let first = failures.first {
            let title = identity(first.title, first.id)
            if !pendingReady { return "Sign Claude Desktop into \(labels) to retry pending" }
            return failures.count == 1 ? "Retry \(title)" : "Retry \(failures.count) cloud sessions"
        }
        return pendingReady ? "Pending work is ready for this account" : "Sign Claude Desktop into \(labels) to finish pending"
    }
    var progress: Double? {
        guard let completed = progressCompleted, let total = progressTotal, total > 0 else { return nil }
        return Double(completed) / Double(total)
    }

    func canSource(_ account: Account) -> Bool { account.id != to }

    func toggle(_ id: String) {
        guard let account = accounts.first(where: { $0.id == id }), canSource(account) else { return }
        clearResult()
        if from.contains(id) { excluded.insert(id) } else { excluded.remove(id) }
        settle()
    }

    func selectTarget(_ id: String) {
        clearResult()
        if let old = to, old != id, let vacated = lanes.first(where: { $0.value == old })?.key, let taken = lanes.first(where: { $0.value == id })?.key {
            lanes[vacated] = id
            lanes[taken] = old
        }
        to = id
        settle()
    }

    private func settle() {
        if to == nil || !accounts.contains(where: { $0.id == to }) {
            let recent = accounts.sorted { ($0.activeAt ?? 0) > ($1.activeAt ?? 0) }
            let current = accounts.first { $0.active == true } ?? recent.first
            to = recent.first { $0.id != current?.id }?.id
        }
        let ids = accounts.map(\.id)
        var next = lanes.filter { ids.contains($0.key) && ids.contains($0.value) }
        var free = ids.filter { id in !next.values.contains(id) }.makeIterator()
        for id in ids where next[id] == nil { if let source = free.next() { next[id] = source } }
        lanes = next
        excluded = excluded.filter { ids.contains($0) }
        from = Set(accounts.filter(canSource).map(\.id)).subtracting(excluded)
    }

    func panelVisibility(_ visible: Bool) {
        if visible { refresh() }
        else if !running { clearResult() }
    }

    private func clearResult() {
        lines = []
        note = ""
        restartAvailable = false
    }

    func refresh() {
        guard !refreshing else { return }
        refreshing = true
        var text = ""
        run(["accounts", "--json"], line: { text += $0 }) { [weak self] _, _ in
            guard let self else { return }
            refreshing = false
            guard let data = text.data(using: .utf8), let list = try? JSONDecoder().decode([Account].self, from: data) else { return }
            accounts = list
            settle()
        }
    }

    func move() {
        guard ready, let target = accounts.first(where: { $0.id == to }) else { return }
        let args = accounts.filter { from.contains($0.id) }.flatMap { ["--from", $0.selector] } + ["--to", target.selector, "--cloud", "--json"]
        begin()
        run(args, line: { [weak self] in self?.handle($0) }) { [weak self] status, error in self?.finish(status, error) }
    }

    func undo() {
        guard !running else { return }
        begin()
        run(["undo", "--json"], line: { [weak self] in self?.handle($0) }) { [weak self] status, error in self?.finish(status, error) }
    }

    func finishPending() {
        guard pendingReady else { return }
        begin()
        run(["finish", "--json"], line: { [weak self] in self?.handle($0) }) { [weak self] status, error in self?.finish(status, error) }
    }

    func keepLocal() {
        guard canKeepLocal else { return }
        begin()
        run(["keep-local", "--json"], line: { [weak self] in self?.handle($0) }) { [weak self] status, error in self?.finish(status, error) }
    }

    func begin() {
        lines = []
        note = ""
        running = true
        restartAvailable = false
        symbol = "arrow.triangle.2.circlepath"
        badge = "starting"
        progressCompleted = nil
        progressTotal = nil
        pendingResult = false
    }

    private func handle(_ line: String) {
        guard let data = line.data(using: .utf8), let event = try? JSONDecoder().decode(Event.self, from: data) else { return }
        if let stage = event.stage, let text = event.text {
            if event.live == true {
                progressCompleted = event.completed
                progressTotal = event.total
                badge = event.completed != nil && event.total != nil ? "\(stage) \(text)" : stage
            } else {
                progressCompleted = nil
                progressTotal = nil
                badge = stage
                lines.removeAll { $0.0 == stage }
                lines.append((stage, text))
            }
        } else if let reconciled = event.reconciled {
            lines = [("recovered", reconciled.title + " | " + reconciled.error)]
            note = event.retry == true ? "Run Undo last again if still wanted" : ""
            restartAvailable = false
        } else if event.done == true {
            let moved = event.moved ?? 0
            let rescued = event.rescued ?? 0
            let cloudArchived = event.cloudArchived ?? 0
            let cloudChecked = event.cloudChecked ?? 0
            let cloudRestored = event.cloudRestored ?? 0
            let newerCloud = event.newerCloud ?? 0
            let pendingCloud = event.pendingCloud ?? 0
            let pendingUndo = event.pendingUndo ?? []
            let keptLocal = event.keptLocal ?? 0
            pendingResult = event.complete == false || pendingCloud > 0 || !pendingUndo.isEmpty
            let failed = event.failed ?? []
            if !failed.isEmpty {
                lines.append(("failed", failed.map { identity($0.title, $0.id) + " | " + $0.error }.joined(separator: "\n")))
            }
            let problems = event.problems ?? []
            for problem in problems { lines.append(("check", identity(problem.title, problem.id) + " | " + problem.check + " failed")) }
            let retired = event.retired ?? 0
            var outcomes: [String] = []
            if moved - rescued > 0 { outcomes.append(quantity(moved - rescued, "session moved", "sessions moved")) }
            if rescued > 0 { outcomes.append(quantity(rescued, "remote branch rescued", "remote branches rescued")) }
            if cloudArchived > 0 { outcomes.append(quantity(cloudArchived, "cloud mirror archived", "cloud mirrors archived")) }
            if cloudChecked > 0 { outcomes.append(quantity(cloudChecked, "cloud source checked", "cloud sources checked")) }
            if cloudRestored > 0 { outcomes.append(quantity(cloudRestored, "cloud mirror restored", "cloud mirrors restored")) }
            if newerCloud > 0 { outcomes.append(quantity(newerCloud, "newer cloud session left for next move", "newer cloud sessions left for next move")) }
            if pendingCloud > 0 { outcomes.append(quantity(pendingCloud, "cloud check pending", "cloud checks pending")) }
            if !pendingUndo.isEmpty { outcomes.append("Undo pending for \(pendingUndo.joined(separator: " or "))") }
            if keptLocal > 0 { outcomes.append("Local move kept, " + quantity(keptLocal, "cloud check cancelled", "cloud checks cancelled")) }
            if moved == 0, retired > 0 { outcomes.append(quantity(retired, "source entry retired", "source entries retired")) }
            if !failed.isEmpty { outcomes.append("\(failed.count) failed") }
            if !problems.isEmpty { outcomes.append("verification failed") }
            let summary = outcomes.isEmpty ? "Nothing to move" : outcomes.joined(separator: ", ")
            restartAvailable = event.restart ?? false
            note = summary
            notify(summary, problems.isEmpty ? (event.note ?? "") : "Check the receipt before trusting the copies")
        } else if event.undone != nil {
            restartAvailable = event.restart ?? false
            note = restartAvailable ? "" : event.note ?? ""
            let restored = event.restored ?? 0
            let cloudRestored = event.cloudRestored ?? 0
            notify(cloudRestored > 0 ? quantity(cloudRestored, "cloud mirror restored", "cloud mirrors restored") : restored > 0 ? quantity(restored, "source entry restored", "source entries restored") : quantity(event.sessions ?? 0, "session undone", "sessions undone"), event.note ?? "")
        } else if let refused = event.refused {
            note = event.reason ?? "Undo refused, \(refused.count) sessions changed since the move"
            restartAvailable = false
            lines = refused.map { ("kept", $0) }
        } else if event.nothing == true {
            note = "Nothing to undo"
            restartAvailable = false
        }
    }

    private func identity(_ title: String?, _ id: String?) -> String {
        [title, id.map { String($0.prefix(8)) }].compactMap { $0 }.joined(separator: " | ")
    }

    private func quantity(_ value: Int, _ singular: String, _ plural: String) -> String {
        "\(value) \(value == 1 ? singular : plural)"
    }

    func restartDesktop() {
        note = "restarting Claude Desktop"
        restartAvailable = false
        DispatchQueue.global().async { [weak self] in
            let quit = Model.shell("/usr/bin/osascript", ["-e", "quit app \"Claude\""]) == 0
            var gone = false
            for _ in 0..<40 {
                if Model.shell("/usr/bin/pgrep", ["-x", "Claude"]) != 0 { gone = true; break }
                Thread.sleep(forTimeInterval: 0.25)
            }
            let opened = gone && Model.shell("/usr/bin/open", ["-a", "Claude"]) == 0
            DispatchQueue.main.async { self?.note = quit && opened ? "" : "could not restart Claude Desktop, quit and reopen it yourself" }
        }
    }

    nonisolated private static func shell(_ executable: String, _ arguments: [String]) -> Int32 {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: executable)
        process.arguments = arguments
        process.standardOutput = FileHandle.nullDevice
        process.standardError = FileHandle.nullDevice
        do { try process.run() } catch { return 1 }
        process.waitUntilExit()
        return process.terminationStatus
    }

    nonisolated private static func capture(_ executable: String, _ arguments: [String]) -> String {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: executable)
        process.arguments = arguments
        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = FileHandle.nullDevice
        do { try process.run() } catch { return "" }
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        return String(decoding: data, as: UTF8.self)
    }

    private func finish(_ status: Int32, _ error: String) {
        running = false
        badge = ""
        progressCompleted = nil
        progressTotal = nil
        excluded = []
        to = nil
        symbol = pendingResult ? "clock.arrow.circlepath" : status == 0 ? "checkmark" : "exclamationmark.triangle"
        if status != 0, note.isEmpty { note = error.isEmpty ? "Failed, run npx claude-transplant in a terminal" : error }
        DispatchQueue.main.asyncAfter(deadline: .now() + 4) { [weak self] in self?.symbol = "arrow.left.arrow.right" }
        refresh()
    }

    private func notify(_ title: String, _ body: String) {
        let content = UNMutableNotificationContent()
        content.title = title
        content.body = body.sentence
        UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: UUID().uuidString, content: content, trigger: nil))
    }

    private func node(_ configured: String) -> String {
        if FileManager.default.isExecutableFile(atPath: configured) { return configured }
        let probe = Process()
        probe.executableURL = URL(fileURLWithPath: "/bin/zsh")
        probe.arguments = ["-lc", "command -v node"]
        let pipe = Pipe()
        probe.standardOutput = pipe
        probe.standardError = FileHandle.nullDevice
        try? probe.run()
        probe.waitUntilExit()
        let found = String(decoding: pipe.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
        return found.isEmpty ? configured : found
    }

    private func run(_ args: [String], line: @escaping (String) -> Void, done: @escaping (Int32, String) -> Void) {
        guard let config else { done(1, "Menubar configuration is missing, run npx claude-transplant menubar"); return }
        let process = Process()
        process.executableURL = URL(fileURLWithPath: node(config.node))
        process.arguments = [config.script] + args
        let pipe = Pipe()
        let errorURL = FileManager.default.temporaryDirectory.appendingPathComponent("claude-transplant-\(UUID().uuidString).err")
        FileManager.default.createFile(atPath: errorURL.path, contents: nil)
        guard let errorHandle = try? FileHandle(forWritingTo: errorURL) else { done(1, "Could not capture command errors"); return }
        process.standardOutput = pipe
        process.standardError = errorHandle
        do { try process.run() } catch {
            try? errorHandle.close()
            try? FileManager.default.removeItem(at: errorURL)
            done(1, error.localizedDescription)
            return
        }
        DispatchQueue.global().async {
            let handle = pipe.fileHandleForReading
            var buffer = Data()
            while true {
                let chunk = handle.availableData
                if chunk.isEmpty { break }
                buffer.append(chunk)
                while let newline = buffer.firstIndex(of: 10) {
                    let text = String(decoding: buffer[buffer.startIndex..<newline], as: UTF8.self)
                    buffer.removeSubrange(buffer.startIndex...newline)
                    DispatchQueue.main.async { line(text) }
                }
            }
            process.waitUntilExit()
            try? errorHandle.close()
            let error = (try? String(contentsOf: errorURL, encoding: .utf8))?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            try? FileManager.default.removeItem(at: errorURL)
            let status = process.terminationStatus
            DispatchQueue.main.async { done(status, error) }
        }
    }
}

struct RowKey: PreferenceKey {
    static let defaultValue: [String: Anchor<CGRect>] = [:]
    static func reduce(value: inout [String: Anchor<CGRect>], nextValue: () -> [String: Anchor<CGRect>]) {
        value.merge(nextValue()) { $1 }
    }
}

struct Row: View {
    let account: Account
    let radio: Bool
    let selected: Bool
    let muted: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 9) {
                Image(systemName: selected ? (radio ? "largecircle.fill.circle" : "checkmark.circle.fill") : "circle")
                    .font(.system(size: 15))
                    .foregroundStyle(selected ? AnyShapeStyle(Color.accentColor) : AnyShapeStyle(.tertiary))
                VStack(alignment: .leading, spacing: 0) {
                    Text(account.name).font(.system(size: 13, weight: selected ? .semibold : .medium)).lineLimit(1).truncationMode(.middle)
                    HStack(spacing: 6) {
                        Text(account.plan).font(.system(size: 11)).foregroundStyle(.secondary).lineLimit(1)
                        if account.active == true { Tag(text: "active", color: .green) }
                        if account.pending != nil { Tag(text: account.pendingFailures?.isEmpty == false ? "retry" : "pending", color: .orange) }
                    }
                }
                Spacer(minLength: 0)
            }
            .frame(height: 34)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .opacity(muted ? 0.35 : 1)
        .anchorPreference(key: RowKey.self, value: .bounds) { [(radio ? "to/" : "from/") + account.id: $0] }
    }
}

struct Tag: View {
    let text: String
    let color: Color

    var body: some View {
        Text(text)
            .font(.system(size: 10, weight: .semibold))
            .padding(.horizontal, 6)
            .padding(.vertical, 1.5)
            .background(color.opacity(0.18), in: Capsule())
            .foregroundStyle(color)
    }
}

struct Arrow: Shape {
    var start: CGPoint
    var end: CGPoint

    var animatableData: AnimatablePair<CGPoint.AnimatableData, CGPoint.AnimatableData> {
        get { AnimatablePair(start.animatableData, end.animatableData) }
        set { start.animatableData = newValue.first; end.animatableData = newValue.second }
    }

    func path(in rect: CGRect) -> Path {
        var path = Path()
        let span = end.x - start.x
        let c1 = CGPoint(x: start.x + span * 0.55, y: start.y)
        let c2 = CGPoint(x: end.x - span * 0.45, y: end.y)
        path.move(to: start)
        path.addCurve(to: end, control1: c1, control2: c2)
        let mark = Arrow.point(start, c1, c2, end, 0.15)
        let tangent = Arrow.tangent(start, c1, c2, end, 0.15)
        let length = max(0.001, hypot(tangent.x, tangent.y))
        let u = CGPoint(x: tangent.x / length, y: tangent.y / length)
        let n = CGPoint(x: -u.y, y: u.x)
        let size = 4.6
        let tip = CGPoint(x: mark.x + u.x * size * 0.7, y: mark.y + u.y * size * 0.7)
        let back = CGPoint(x: mark.x - u.x * size * 0.7, y: mark.y - u.y * size * 0.7)
        path.move(to: CGPoint(x: back.x + n.x * size, y: back.y + n.y * size))
        path.addLine(to: tip)
        path.addLine(to: CGPoint(x: back.x - n.x * size, y: back.y - n.y * size))
        return path
    }

    private static func point(_ p0: CGPoint, _ p1: CGPoint, _ p2: CGPoint, _ p3: CGPoint, _ t: Double) -> CGPoint {
        let u = 1 - t
        let a = u * u * u, b = 3 * u * u * t, c = 3 * u * t * t, d = t * t * t
        return CGPoint(x: a * p0.x + b * p1.x + c * p2.x + d * p3.x, y: a * p0.y + b * p1.y + c * p2.y + d * p3.y)
    }

    private static func tangent(_ p0: CGPoint, _ p1: CGPoint, _ p2: CGPoint, _ p3: CGPoint, _ t: Double) -> CGPoint {
        let u = 1 - t
        let a = 3 * u * u, b = 6 * u * t, c = 3 * t * t
        return CGPoint(x: a * (p1.x - p0.x) + b * (p2.x - p1.x) + c * (p3.x - p2.x), y: a * (p1.y - p0.y) + b * (p2.y - p1.y) + c * (p3.y - p2.y))
    }
}

struct Arrows: View {
    @EnvironmentObject private var model: Model
    let anchors: [String: Anchor<CGRect>]

    var body: some View {
        GeometryReader { proxy in
            let end = model.to.flatMap { anchors["to/" + $0] }.map { proxy[$0] }.map { CGPoint(x: $0.minX - 10, y: $0.midY) }
            ForEach(model.accounts) { lane in
                let source = model.lanes[lane.id] ?? lane.id
                if let rect = anchors["from/" + source].map({ proxy[$0] }) {
                    let start = CGPoint(x: rect.maxX + 10, y: rect.midY)
                    let visible = end != nil && source != model.to && model.from.contains(source)
                    Arrow(start: start, end: end ?? start)
                        .stroke(Color.accentColor.opacity(0.9), style: StrokeStyle(lineWidth: 1.6, lineCap: .round, lineJoin: .round))
                        .animation(.spring(response: 0.45, dampingFraction: 0.86), value: start)
                        .animation(.spring(response: 0.45, dampingFraction: 0.86), value: end)
                        .opacity(visible ? 1 : 0)
                        .animation(.easeInOut(duration: 0.22), value: visible)
                }
            }
        }
        .allowsHitTesting(false)
    }
}

struct Bar: View {
    let value: Double

    var body: some View {
        GeometryReader { geo in
            ZStack(alignment: .leading) {
                Capsule().fill(.quaternary)
                Capsule().fill(Color.accentColor).frame(width: max(6, geo.size.width * value))
            }
        }
        .frame(height: 6)
        .animation(.easeOut(duration: 0.2), value: value)
    }
}

struct ActivityBar: View {
    var body: some View {
        TimelineView(.animation(minimumInterval: 1.0 / 30.0)) { timeline in
            GeometryReader { geo in
                let width = geo.size.width
                let segment = max(24, width * 0.22)
                let phase = timeline.date.timeIntervalSinceReferenceDate.truncatingRemainder(dividingBy: 1.1) / 1.1
                ZStack(alignment: .leading) {
                    Capsule().fill(.quaternary)
                    Capsule().fill(Color.accentColor).frame(width: segment).offset(x: -segment + (width + segment) * phase)
                }
            }
        }
        .frame(height: 6)
        .clipped()
    }
}

struct Pill: View {
    let title: String
    let prominent: Bool
    let enabled: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Text(title)
                .font(.body.weight(.medium))
                .padding(.horizontal, 16)
                .padding(.vertical, 7)
                .background(prominent ? AnyShapeStyle(Color.accentColor) : AnyShapeStyle(.quaternary), in: RoundedRectangle(cornerRadius: 8, style: .continuous))
                .foregroundStyle(prominent ? AnyShapeStyle(.white) : AnyShapeStyle(.primary))
        }
        .buttonStyle(.plain)
        .disabled(!enabled)
        .opacity(enabled ? 1 : 0.4)
    }
}

struct Panel: View {
    @EnvironmentObject private var model: Model

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 8) {
                Text("Claude Transplant").font(.system(.title3, design: .rounded, weight: .semibold))
                Spacer()
                Button(action: { model.refresh() }) { Image(systemName: "arrow.clockwise") }.buttonStyle(.plain).foregroundStyle(.secondary)
            }
            board
            if !model.lines.isEmpty || !model.note.isEmpty || !model.pendingPrompt.isEmpty { Divider() }
            ForEach(Array(model.lines.enumerated()), id: \.offset) { item in
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Text(item.element.0).foregroundStyle(.secondary).frame(width: 60, alignment: .leading)
                    Text(item.element.1).fixedSize(horizontal: false, vertical: true)
                }
                .font(.system(.caption, design: .monospaced))
            }
            if model.running {
                if let progress = model.progress { Bar(value: progress) } else { ActivityBar() }
            }
            if !model.note.isEmpty || !model.pendingPrompt.isEmpty {
                Text((model.note.isEmpty ? model.pendingPrompt : model.note).sentence).font(.callout.weight(.medium))
            }
            if model.restartAvailable {
                Button(action: { model.restartDesktop() }) { Text("Restart Claude Desktop to see them").font(.callout.weight(.medium)).underline() }.buttonStyle(.plain)
            }
            HStack(spacing: 10) {
                if model.pendingAccounts.isEmpty {
                    Pill(title: "Move", prominent: true, enabled: model.ready) { model.move() }
                } else {
                    Pill(title: "Finish pending", prominent: true, enabled: model.pendingReady) { model.finishPending() }
                    if model.canKeepLocal { Pill(title: "Keep local", prominent: false, enabled: model.canKeepLocal) { model.keepLocal() } }
                }
                Pill(title: "Undo last", prominent: false, enabled: !model.running) { model.undo() }
                Spacer()
                Button("Quit") { NSApplication.shared.terminate(nil) }.buttonStyle(.plain).foregroundStyle(.secondary)
            }
        }
        .padding(16)
        .frame(width: 2 * columnWidth + Panel.gap + 32)
        .onAppear { if !model.snapshot { model.panelVisibility(true) } }
        .onDisappear { if !model.snapshot { model.panelVisibility(false) } }
        .onReceive(NotificationCenter.default.publisher(for: NSWindow.didChangeOcclusionStateNotification)) { note in
            if !model.snapshot, let window = note.object as? NSWindow { model.panelVisibility(window.occlusionState.contains(.visible)) }
        }
    }

    private var board: some View {
        let width = columnWidth
        return HStack(alignment: .top, spacing: 0) {
            column("From") {
                ForEach(model.accounts) { account in
                    Row(account: account, radio: false, selected: model.from.contains(account.id), muted: !model.canSource(account)) { model.toggle(account.id) }
                }
            }
            .frame(width: width, alignment: .leading)
            Spacer(minLength: Panel.gap)
            column("To") {
                ForEach(model.accounts) { account in
                    Row(account: account, radio: true, selected: model.to == account.id, muted: false) { model.selectTarget(account.id) }
                }
            }
            .frame(width: width, alignment: .leading)
        }
        .overlayPreferenceValue(RowKey.self) { anchors in
            Arrows(anchors: anchors)
        }
    }

    private var columnWidth: CGFloat {
        let name: [NSAttributedString.Key: Any] = [.font: NSFont.systemFont(ofSize: 13, weight: .semibold)]
        let plan: [NSAttributedString.Key: Any] = [.font: NSFont.systemFont(ofSize: 11)]
        let widest = model.accounts.map { account -> CGFloat in
            let tags = CGFloat((account.active == true ? 48 : 0) + (account.pending != nil ? 54 : 0))
            return max((account.name as NSString).size(withAttributes: name).width, (account.plan as NSString).size(withAttributes: plan).width + tags)
        }.max() ?? 0
        return min(300, max(180, 44 + ceil(widest)))
    }

    static let gap: CGFloat = 150

    private func column<Content: View>(_ title: String, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            Text(title.uppercased()).font(.caption2.weight(.semibold)).tracking(0.8).foregroundStyle(.secondary).padding(.bottom, 4)
            content()
        }
    }
}

enum Snapshot {
    @MainActor
    static func data(_ model: Model) -> Data? {
        let renderer = ImageRenderer(content: Panel().environmentObject(model).background(Color(white: 0.11)).environment(\.colorScheme, .dark))
        renderer.scale = 2
        guard let tiff = renderer.nsImage?.tiffRepresentation else { return nil }
        return NSBitmapImageRep(data: tiff)?.representation(using: .png, properties: [:])
    }

    @MainActor
    static func write(_ model: Model, to file: String) {
        guard let png = data(model) else { exit(1) }
        do { try png.write(to: URL(fileURLWithPath: file)) } catch { exit(1) }
        exit(0)
    }
}

enum Demo {
    static let accounts = [
        Account(account: "alex-personal", org: "personal", email: "alex@example.com", orgName: "Personal", label: "alex@example.com · Personal", active: true, sessions: 84, activeAt: 400, pending: nil, pendingFailures: nil),
        Account(account: "alex-team", org: "team", email: "alex@example.com", orgName: "Acme Inc.", label: "alex@example.com · Acme Inc.", active: false, sessions: 212, activeAt: 300, pending: nil, pendingFailures: nil),
        Account(account: "sam-personal", org: "personal", email: "sam@example.com", orgName: "Personal", label: "sam@example.com · Personal", active: false, sessions: 35, activeAt: 200, pending: nil, pendingFailures: nil),
        Account(account: "sam-team", org: "team", email: "sam@example.com", orgName: "Northwind", label: "sam@example.com · Northwind", active: false, sessions: 12, activeAt: 100, pending: nil, pendingFailures: nil)
    ]

    @MainActor
    static func play(_ model: Model, into directory: String) {
        let root = URL(fileURLWithPath: directory)
        try? FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        var durations: [Int] = []
        func snap(_ milliseconds: Int) {
            guard let png = Snapshot.data(model) else { exit(1) }
            try? png.write(to: root.appendingPathComponent(String(format: "frame-%03d.png", durations.count)))
            durations.append(milliseconds)
        }
        snap(1200)
        model.selectTarget(accounts[2].id)
        snap(1200)
        model.toggle(accounts[0].id)
        snap(900)
        model.toggle(accounts[0].id)
        snap(600)
        model.begin()
        model.lines = [("inventory", "308 records | 3 already there | 305 to move")]
        snap(300)
        for completed in [75, 170, 250, 305] {
            model.progressCompleted = completed
            model.progressTotal = 305
            snap(180)
        }
        model.running = false
        model.badge = ""
        model.progressCompleted = nil
        model.progressTotal = nil
        model.lines.append(("move", "305 ✓ | zero-copy"))
        model.lines.append(("verify", "transcripts unchanged ✓ | sidecars unchanged ✓ | desktop ✓"))
        model.symbol = "checkmark"
        model.note = "305 sessions moved"
        model.restartAvailable = true
        snap(2400)
        try? JSONSerialization.data(withJSONObject: durations).write(to: root.appendingPathComponent("durations.json"))
        exit(0)
    }
}

@main
struct TransplantApp: App {
    @StateObject private var model: Model

    init() {
        let args = CommandLine.arguments
        if let index = args.firstIndex(of: "--demo"), index + 1 < args.count {
            let model = Model(demo: Demo.accounts)
            _model = StateObject(wrappedValue: model)
            let directory = args[index + 1]
            DispatchQueue.main.async { Demo.play(model, into: directory) }
        } else if let index = args.firstIndex(of: "--snapshot"), index + 1 < args.count {
            let model = Model(snapshot: true)
            _model = StateObject(wrappedValue: model)
            let file = args[index + 1]
            DispatchQueue.main.async { Snapshot.write(model, to: file) }
        } else {
            _model = StateObject(wrappedValue: Model())
        }
    }

    var body: some Scene {
        MenuBarExtra {
            Panel().environmentObject(model)
        } label: {
            HStack(spacing: 4) {
                Image(systemName: model.symbol)
                if !model.badge.isEmpty { Text(model.badge).monospacedDigit() }
            }
        }
        .menuBarExtraStyle(.window)
    }
}
