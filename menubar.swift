import Combine
import SwiftUI
import UserNotifications

struct Account: Decodable, Identifiable {
    let account: String
    let org: String
    let label: String
    let stats: String
    let active: Bool?
    let pending: String?
    let pendingFailures: [Failure]?
    var id: String { account + "/" + org }
    var selector: String { account + " " + org }
    var detail: String { stats.replacingOccurrences(of: " | active", with: "").replacingOccurrences(of: " | ", with: "  ·  ") }
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
    let pendingLabels: [String]?
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
    @Published var lines: [(String, String)] = []
    @Published var note = ""
    @Published var badge = ""
    @Published var symbol = "arrow.left.arrow.right"
    @Published var running = false
    @Published var restartAvailable = false
    @Published var progressCompleted: Int?
    @Published var progressTotal: Int?
    let demo: Bool
    private let config: Config?
    private var refreshing = false
    private var pendingResult = false

    init(demo: Bool = false) {
        self.demo = demo
        if demo {
            config = nil
            accounts = Demo.accounts
            return
        }
        let file = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support/claude-transplant/menubar.json")
        config = (try? Data(contentsOf: file)).flatMap { try? JSONDecoder().decode(Config.self, from: $0) }
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound]) { _, _ in }
        refresh()
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

    func toggle(_ id: String) {
        if from.isEmpty { clearResult() }
        if from.contains(id) { from.remove(id) } else { from.insert(id) }
        if to == id { to = nil }
    }

    func selectTarget(_ id: String) {
        clearResult()
        if from.isEmpty { from = Set(accounts.map(\.id).filter { $0 != id }) }
        else { from.remove(id) }
        to = id
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
            from = from.filter { id in list.contains { $0.id == id } }
            if let current = to, !list.contains(where: { $0.id == current }) { to = nil }
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
            if moved - rescued > 0 { outcomes.append("\(moved - rescued) sessions moved") }
            if rescued > 0 { outcomes.append("\(rescued) remote branches rescued") }
            if cloudArchived > 0 { outcomes.append("\(cloudArchived) cloud mirrors archived") }
            if cloudChecked > 0 { outcomes.append("\(cloudChecked) cloud source checked") }
            if cloudRestored > 0 { outcomes.append("\(cloudRestored) cloud mirrors restored") }
            if newerCloud > 0 { outcomes.append("\(newerCloud) newer cloud sessions left for next move") }
            if pendingCloud > 0 { outcomes.append("\(pendingCloud) cloud \(pendingCloud == 1 ? "check" : "checks") pending") }
            if !pendingUndo.isEmpty { outcomes.append("Undo pending for \(pendingUndo.joined(separator: " or "))") }
            if keptLocal > 0 { outcomes.append("Local move kept, \(keptLocal) cloud checks cancelled") }
            if moved == 0, retired > 0 { outcomes.append("\(retired) source entries retired") }
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
            notify(cloudRestored > 0 ? "\(cloudRestored) cloud mirrors restored" : restored > 0 ? "\(restored) source entries restored" : "\(event.sessions ?? 0) sessions undone", event.note ?? "")
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

    private func finish(_ status: Int32, _ error: String) {
        running = false
        badge = ""
        progressCompleted = nil
        progressTotal = nil
        from = []
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
        guard let config else { done(1, "Menubar configuration is missing"); return }
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

struct AccountRow: View {
    let account: Account
    let sourceOn: Bool
    let targetOn: Bool
    let toggleSource: () -> Void
    let chooseTarget: () -> Void

    var body: some View {
        HStack(spacing: 8) {
            Button(action: toggleSource) {
                HStack(spacing: 8) {
                    Image(systemName: sourceOn ? "checkmark.circle.fill" : "circle")
                        .foregroundStyle(sourceOn ? AnyShapeStyle(Color.accentColor) : AnyShapeStyle(.tertiary))
                    Text(account.label).lineLimit(1).truncationMode(.tail).layoutPriority(1)
                    if account.active == true {
                        Text("active")
                            .font(.system(size: 10, weight: .semibold))
                            .padding(.horizontal, 6)
                            .padding(.vertical, 2)
                            .background(Color.green.opacity(0.18), in: Capsule())
                            .foregroundStyle(.green)
                    }
                    if account.pending != nil {
                        Text(account.pendingFailures?.isEmpty == false ? "retry" : "pending")
                            .font(.system(size: 10, weight: .semibold))
                            .padding(.horizontal, 6)
                            .padding(.vertical, 2)
                            .background(Color.orange.opacity(0.18), in: Capsule())
                            .foregroundStyle(.orange)
                    }
                    Spacer(minLength: 12)
                    Text(account.detail)
                        .font(.system(.caption, design: .rounded))
                        .monospacedDigit()
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                        .truncationMode(.tail)
                        .frame(maxWidth: 190, alignment: .trailing)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            Button(action: chooseTarget) {
                Image(systemName: targetOn ? "largecircle.fill.circle" : "circle")
                    .foregroundStyle(targetOn ? AnyShapeStyle(Color.accentColor) : AnyShapeStyle(.tertiary))
            }
            .buttonStyle(.plain)
        }
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
                    Capsule()
                        .fill(Color.accentColor)
                        .frame(width: segment)
                        .offset(x: -segment + (width + segment) * phase)
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
        VStack(alignment: .leading, spacing: 14) {
            HStack {
                Text("Claude Transplant").font(.system(.title3, design: .rounded, weight: .semibold))
                Spacer()
                Button(action: { model.refresh() }) { Image(systemName: "arrow.clockwise") }.buttonStyle(.plain).foregroundStyle(.secondary)
            }
            VStack(alignment: .leading, spacing: 6) {
                HStack {
                    Text("FROM")
                    Spacer()
                    Text("TO")
                }
                .font(.caption2.weight(.semibold))
                .tracking(0.8)
                .foregroundStyle(.secondary)
                ForEach(model.accounts) { account in
                    AccountRow(
                        account: account,
                        sourceOn: model.from.contains(account.id),
                        targetOn: model.to == account.id,
                        toggleSource: { model.toggle(account.id) },
                        chooseTarget: { model.selectTarget(account.id) }
                    )
                }
            }
            if !model.lines.isEmpty || !model.note.isEmpty || !model.pendingPrompt.isEmpty { Divider() }
            ForEach(Array(model.lines.enumerated()), id: \.offset) { item in
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Text(item.element.0).foregroundStyle(.secondary).frame(width: 60, alignment: .leading)
                    Text(item.element.1).fixedSize(horizontal: false, vertical: true)
                }
                .font(.system(.caption, design: .monospaced))
            }
            if model.running {
                if let progress = model.progress { Bar(value: progress) }
                else { ActivityBar() }
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
                    if model.canKeepLocal {
                        Pill(title: "Keep local", prominent: false, enabled: model.canKeepLocal) { model.keepLocal() }
                    }
                }
                Pill(title: "Undo last", prominent: false, enabled: !model.running) { model.undo() }
                Spacer()
                Button("Quit") { NSApplication.shared.terminate(nil) }.buttonStyle(.plain).foregroundStyle(.secondary)
            }
        }
        .padding(18)
        .frame(width: 600)
        .onAppear { if !model.demo { model.panelVisibility(true) } }
        .onDisappear { if !model.demo { model.panelVisibility(false) } }
        .onReceive(NotificationCenter.default.publisher(for: NSWindow.didChangeOcclusionStateNotification)) { note in
            if !model.demo, let window = note.object as? NSWindow { model.panelVisibility(window.occlusionState.contains(.visible)) }
        }
    }
}

struct MenuBar: View {
    let open: Bool
    let symbol: String
    let badge: String

    var body: some View {
        HStack(spacing: 0) {
            Image(systemName: "apple.logo").padding(.leading, 18).padding(.trailing, 18)
            Text("Finder").fontWeight(.bold).padding(.trailing, 18)
            ForEach(["File", "Edit", "View", "Go", "Window", "Help"], id: \.self) { Text($0).padding(.trailing, 18) }
            Spacer()
            HStack(spacing: 4) {
                Image(systemName: symbol).font(.system(size: 12, weight: .medium))
                if !badge.isEmpty { Text(badge).font(.system(size: 12)).monospacedDigit() }
            }
            .padding(.horizontal, 7)
            .frame(height: 20)
            .background(open ? Color.white.opacity(0.22) : Color.clear, in: RoundedRectangle(cornerRadius: 5))
            Image(systemName: "wifi").frame(width: 28)
            Image(systemName: "battery.100").frame(width: 28)
            Text("Tue 9:41 AM").frame(width: 92, alignment: .trailing).padding(.trailing, 12)
        }
        .font(.system(size: 13))
        .foregroundStyle(.white)
        .frame(height: 24)
        .background(Color.black.opacity(0.32))
    }
}

struct Cursor: View {
    static func arrow() -> Path {
        var path = Path()
        path.move(to: CGPoint(x: 0, y: 0))
        path.addLine(to: CGPoint(x: 0, y: 17))
        path.addLine(to: CGPoint(x: 4.5, y: 13))
        path.addLine(to: CGPoint(x: 8, y: 20))
        path.addLine(to: CGPoint(x: 10.5, y: 19))
        path.addLine(to: CGPoint(x: 7, y: 12))
        path.addLine(to: CGPoint(x: 12.5, y: 12))
        path.closeSubpath()
        return path
    }

    var body: some View {
        Cursor.arrow().fill(.black)
            .overlay(Cursor.arrow().stroke(.white, lineWidth: 1.2))
            .frame(width: 14, height: 21)
    }
}

struct Screen: View {
    @ObservedObject var model: Model
    let open: Bool
    let cursor: CGPoint

    var body: some View {
        ZStack(alignment: .topLeading) {
            LinearGradient(
                colors: [
                    Color(red: 0.13, green: 0.17, blue: 0.38),
                    Color(red: 0.42, green: 0.16, blue: 0.36),
                    Color(red: 0.86, green: 0.42, blue: 0.30)
                ],
                startPoint: .topLeading,
                endPoint: .bottomTrailing
            )
            VStack(alignment: .trailing, spacing: 6) {
                MenuBar(open: open, symbol: model.symbol, badge: model.badge)
                if open {
                    Panel().environmentObject(model)
                        .background(Color(white: 0.11))
                        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                        .shadow(color: .black.opacity(0.5), radius: 26, y: 14)
                        .padding(.trailing, 8)
                }
            }
            Cursor().offset(x: cursor.x, y: cursor.y)
        }
        .frame(width: 760, height: 620, alignment: .topLeading)
        .environment(\.colorScheme, .dark)
    }
}

enum Demo {
    static let accounts = [
        Account(account: "john", org: "personal", label: "john@example.com · Personal", stats: "86 | 2h ago | api", active: false, pending: nil, pendingFailures: nil),
        Account(account: "john", org: "team", label: "john@example.com · Team", stats: "212 | 3d ago | api", active: false, pending: nil, pendingFailures: nil),
        Account(account: "john2", org: "personal", label: "john2@example.com · Personal", stats: "35 | 5d ago | notes", active: false, pending: nil, pendingFailures: nil),
        Account(account: "john2", org: "team", label: "john2@example.com · Team", stats: "12 | 4m ago | notes", active: true, pending: nil, pendingFailures: nil)
    ]

    @MainActor
    static func play(_ model: Model, into dir: URL) {
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        var durations: [Int] = []
        var cursor = CGPoint(x: 430, y: 340)
        var open = false
        func snap(_ ms: Int) {
            let renderer = ImageRenderer(content: Screen(model: model, open: open, cursor: cursor))
            renderer.scale = 2
            guard let tiff = renderer.nsImage?.tiffRepresentation, let png = NSBitmapImageRep(data: tiff)?.representation(using: .png, properties: [:]) else { return }
            try? png.write(to: dir.appendingPathComponent(String(format: "frame-%03d.png", durations.count)))
            durations.append(ms)
        }
        func glide(to target: CGPoint, frames: Int) {
            let start = cursor
            for step in 1...frames {
                let t = Double(step) / Double(frames)
                let eased = t < 0.5 ? 2 * t * t : 1 - pow(-2 * t + 2, 2) / 2
                cursor = CGPoint(x: start.x + (target.x - start.x) * eased, y: start.y + (target.y - start.y) * eased)
                snap(step == frames ? 180 : 40)
            }
        }
        snap(700)
        glide(to: CGPoint(x: 586, y: 12), frames: 9)
        open = true
        snap(900)
        glide(to: CGPoint(x: 722, y: 150), frames: 9)
        model.selectTarget(accounts[2].id)
        snap(1100)
        glide(to: CGPoint(x: 205, y: 220), frames: 8)
        model.begin()
        model.lines = [("inventory", "310 records | 1 without history | 1 blocked | 3 already there | 5 cloud mirrors | 1 cloud rescue | 2 cloud checks pending | 305 to move")]
        snap(250)
        glide(to: CGPoint(x: 150, y: 420), frames: 6)
        for done in stride(from: 0, through: 305, by: 23) {
            model.progressCompleted = done
            model.progressTotal = 305
            model.badge = "move \(done)/305"
            snap(100)
        }
        model.progressCompleted = 305
        model.progressTotal = 305
        model.badge = "move 305/305"
        snap(150)
        model.badge = ""
        model.progressCompleted = nil
        model.progressTotal = nil
        model.lines.append(("move", "306 ✓ | 141,347 events | 305 zero-copy | 1 rescued"))
        snap(350)
        model.lines.append(("sidecars", "1,842 files | unchanged ✓"))
        snap(350)
        model.lines.append(("desktop", "306 records | 240 archived | 66 active"))
        snap(350)
        model.lines.append(("verify", "transcripts unchanged ✓ | sidecars unchanged ✓ | desktop ✓ | 2s"))
        snap(350)
        model.lines.append(("retired", "308 source records → quarantine | transcripts untouched"))
        model.lines.append(("cloud", "5 source mirrors archived"))
        model.lines.append(("pending", "2 source cloud checks"))
        snap(500)
        model.running = false
        model.from = []
        model.to = nil
        model.accounts = [
            Account(account: "john", org: "personal", label: "john@example.com · Personal", stats: "0 | -", active: false, pending: "cloud", pendingFailures: []),
            Account(account: "john", org: "team", label: "john@example.com · Team", stats: "0 | -", active: false, pending: "cloud", pendingFailures: []),
            Account(account: "john2", org: "personal", label: "john2@example.com · Personal", stats: "341 | now | notes", active: false, pending: nil, pendingFailures: nil),
            Account(account: "john2", org: "team", label: "john2@example.com · Team", stats: "0 | -", active: true, pending: nil, pendingFailures: nil)
        ]
        model.symbol = "clock.arrow.circlepath"
        model.note = "305 sessions moved, 1 remote branch rescued, 5 cloud mirrors archived, 2 cloud checks pending"
        model.restartAvailable = true
        snap(2800)
        try? JSONSerialization.data(withJSONObject: durations).write(to: dir.appendingPathComponent("durations.json"))
        exit(0)
    }
}

@main
struct TransplantApp: App {
    @StateObject private var model: Model

    init() {
        let args = CommandLine.arguments
        if let index = args.firstIndex(of: "--demo"), index + 1 < args.count {
            let demo = Model(demo: true)
            _model = StateObject(wrappedValue: demo)
            let dir = URL(fileURLWithPath: args[index + 1])
            DispatchQueue.main.async { Demo.play(demo, into: dir) }
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
