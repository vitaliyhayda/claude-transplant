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
    let signedIn: Bool?
    let activeAt: Double?
    let pending: String?
    let pendingFailures: [Failure]?
    var stats: String? = nil
    var identityState: String? = nil
    var pendingAction: String? = nil
    var pendingWaiting: [HeldRecord]? = nil
    var receiptMoved: Int? = nil
    var receiptDestination: String? = nil
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

struct RestartWorker: Decodable {
    let pid: Int
    let started: String
    let recordId: String?
    let title: String?
    let cwd: String?
}

struct HeldRecord: Decodable {
    let id: String
    let title: String
}

struct MetadataChange: Decodable {
    let id: String
    let title: String?
    let fields: [String]
}


struct Event: Decodable {
    let swept: Bool?
    let error: String?
    let changed: [MetadataChange]?
    let plan: Bool?
    let token: String?
    let kind: String?
    let resume: Bool?
    let affected: [RestartWorker]?
    let held: [HeldRecord]?
    let waiting: [HeldRecord]?
    let pendingLabels: [String]?
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
    let heldCancelled: Int?
    let pendingCloud: Int?
    let pendingUndo: [String]?
    let retired: Int?
    let failed: [Failure]?
    let problems: [Problem]?
    let note: String?
    let restart: Bool?
    let restarted: Bool?
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
    @Published var detailsExpanded = false
    @Published var progressLabel = "Preparing sessions"
    @Published var note = ""
    @Published var badge = ""
    @Published var symbol = "arrow.left.arrow.right"
    @Published var running = false
    @Published private(set) var sweeping = false
    private var queued: (() -> Void)?
    @Published var skipRestartWarning = UserDefaults.standard.bool(forKey: "skipRestartWarning")
    @Published var restartAvailable = false
    @Published var progressCompleted: Int?
    @Published var progressTotal: Int?
    var snapshotFailed = false
    let snapshot: Bool
    let demo: Bool
    private let config: Config?
    private var refreshing = false
    private var pendingResult = false
    private var pendingPlan: Event?
    private var operationArgs: [String] = []
    private var approvalAttempted = false
    private var poller: AnyCancellable?
    private var activeIdentity = ""
    private var targetChosen = false
    private var selectionComplete = false
    private var panelOpen = false
    private var sweepNote: String?

    init(snapshot: Bool = false, config supplied: Config? = nil) {
        self.snapshot = snapshot
        demo = false
        let file = Bundle.main.url(forResource: "menubar", withExtension: "json") ?? FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support/claude-transplant/menubar.json")
        config = supplied ?? (try? Data(contentsOf: file)).flatMap { try? JSONDecoder().decode(Config.self, from: $0) }
        if snapshot {
            guard let config, let text = Model.capture(node(config.node), [config.script, "accounts", "--json"]), let decoded = try? JSONDecoder().decode([Account].self, from: Data(text.utf8)) else { snapshotFailed = true; return }
            accounts = decoded
            settle()
            return
        }
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound]) { _, _ in }
        refresh()
        poller = Timer.publish(every: 15, on: .main, in: .common).autoconnect().sink { [weak self] _ in
            guard let self, !self.running, !self.sweeping else { return }
            self.refresh()
        }
    }

    init(demo accounts: [Account]) {
        snapshot = true
        demo = true
        config = nil
        self.accounts = accounts
        settle()
    }

    var identityLabel: String? { accounts.contains { $0.active == true } ? nil : accounts.first?.identityState == "logged-out" ? "signed out" : "unknown" }
    var pendingAccounts: [Account] { accounts.filter { $0.pending != nil } }
    var activePendingAccount: Account? { pendingAccounts.first { $0.active == true } }
    var canKeepLocal: Bool { !running && pendingAccounts.contains { ["cloud", "local"].contains($0.pending ?? "") } }
    var pendingReady: Bool { !running && pendingAccounts.contains { ["finish", "restart"].contains($0.pendingAction ?? ($0.pending == "local" || $0.active == true ? "finish" : "sign-in")) } && (config != nil || demo) }
    var pendingButtonTitle: String { pendingAccounts.contains { $0.pendingAction == "restart" } ? "Stop and restart" : pendingAccounts.contains { $0.pending == "undo" } ? "Finish Undo" : "Finish move" }
    var ready: Bool { !running && pendingAccounts.isEmpty && !from.isEmpty && to != nil && (config != nil || demo) }
    var pendingPrompt: String {
        guard !pendingAccounts.isEmpty else { return "" }
        let moved = pendingAccounts.compactMap(\.receiptMoved).max() ?? 0
        let waiting = Set(pendingAccounts.flatMap { $0.pendingWaiting ?? [] }.map(\.id)).count
        let issues = pendingAccounts.reduce(0) { $0 + ($1.pendingFailures?.count ?? 0) }
        let signIn = pendingAccounts.filter { $0.pendingAction == "sign-in" }.map(\.label)
        var parts = moved > 0 ? [quantity(moved, "session moved", "sessions moved")] : []
        if waiting > 0 { parts.append("\(waiting) still open") }
        if issues > 0 { parts.append("\(issues) need attention") }
        if !signIn.isEmpty { parts.append("sign into \(signIn.joined(separator: " or ")) to finish") }
        if waiting == 0 && issues == 0 && signIn.isEmpty { parts.append("remaining sessions are ready to move") }
        return parts.isEmpty ? "Remaining sessions are ready to move" : parts.joined(separator: ", ")
    }
    var detailLines: [(String, String)] {
        if !lines.isEmpty { return lines }
        return pendingAccounts.flatMap { account in
            (account.pendingWaiting ?? []).map { ("open", $0.title) } +
            (account.pendingFailures ?? []).map { ("issue", identity($0.title, $0.id) + " | " + $0.error) }
        }
    }
    var displaySummary: String { running ? progressLabel : note.isEmpty ? pendingPrompt : note }
    var progress: Double? {
        guard let completed = progressCompleted, let total = progressTotal, total > 0 else { return nil }
        return Double(completed) / Double(total)
    }

    func canSource(_ account: Account) -> Bool { account.id != to }

    func toggle(_ id: String) {
        guard let account = accounts.first(where: { $0.id == id }), canSource(account) else { return }
        if selectionComplete { excluded = Set(accounts.map(\.id)) }
        clearResult()
        if from.contains(id) { excluded.insert(id) } else { excluded.remove(id) }
        settle()
    }

    func selectTarget(_ id: String) {
        if selectionComplete { excluded = [] }
        clearResult()
        if let old = to, old != id, let vacated = lanes.first(where: { $0.value == old })?.key, let taken = lanes.first(where: { $0.value == id })?.key {
            lanes[vacated] = id
            lanes[taken] = old
        }
        to = id
        targetChosen = true
        settle()
    }

    private func settle() {
        if !accounts.contains(where: { $0.id == to }) {
            to = nil
            targetChosen = false
        }
        if selectionComplete && pendingAccounts.isEmpty {
            to = nil
        } else if let destination = pendingAccounts.compactMap(\.receiptDestination).first {
            to = destination
        } else if !targetChosen {
            let recent = accounts.sorted { ($0.activeAt ?? 0) > ($1.activeAt ?? 0) }
            to = accounts.first(where: { $0.active == true }).flatMap { current in recent.first { $0.id != current.id }?.id }
        }
        let ids = accounts.map(\.id)
        var next = lanes.filter { ids.contains($0.key) && ids.contains($0.value) }
        var free = ids.filter { id in !next.values.contains(id) }.makeIterator()
        for id in ids where next[id] == nil { if let source = free.next() { next[id] = source } }
        lanes = next
        excluded = excluded.filter { ids.contains($0) }
        from = selectionComplete && pendingAccounts.isEmpty ? [] : Set(accounts.filter(canSource).map(\.id)).subtracting(excluded)
    }

    func panelVisibility(_ visible: Bool) {
        panelOpen = visible
        if visible { refresh() }
    }

    private func clearResult() {
        selectionComplete = false
        lines = []
        detailsExpanded = false
        note = ""
        restartAvailable = false
    }

    func refresh() {
        guard !refreshing, !running, !sweeping else { return }
        refreshing = true
        var text = ""
        run(["accounts", "--json"], line: { text += $0 }) { [weak self] _, _ in
            guard let self else { return }
            refreshing = false
            guard let data = text.data(using: .utf8), let list = try? JSONDecoder().decode([Account].self, from: data) else { return }
            accounts = list
            settle()
            let identity = list.filter { $0.active == true }.map(\.id).joined(separator: ",")
            let changed = identity != activeIdentity
            activeIdentity = identity
            if !snapshot && (changed || panelOpen || !pendingAccounts.isEmpty) { sweep() }
        }
    }

    func move() {
        if sweeping { queued = { [weak self] in self?.move() }; return }
        guard ready, let target = accounts.first(where: { $0.id == to }) else { return }
        let args = accounts.filter { from.contains($0.id) }.flatMap { ["--from", $0.selector] } + ["--to", target.selector, "--cloud", "--json"]
        begin()
        runOperation(args)
    }

    func undo() {
        if sweeping { queued = { [weak self] in self?.undo() }; return }
        guard !running else { return }
        begin()
        run(["undo", "--json"], line: { [weak self] in self?.handle($0) }) { [weak self] status, error in self?.finish(status, error) }
    }

    func finishPending() {
        if sweeping { queued = { [weak self] in self?.finishPending() }; return }
        guard pendingReady else { return }
        begin()
        runOperation(["finish", "--json"])
    }

    func keepLocal() {
        if sweeping { queued = { [weak self] in self?.keepLocal() }; return }
        guard canKeepLocal else { return }
        begin()
        run(["keep-local", "--json"], line: { [weak self] in self?.handle($0) }) { [weak self] status, error in self?.finish(status, error) }
    }

    func begin() {
        lines = []
        detailsExpanded = false
        note = ""
        running = true
        restartAvailable = false
        symbol = "arrow.triangle.2.circlepath"
        progressLabel = "Preparing sessions"
        badge = "Preparing"
        progressCompleted = nil
        progressTotal = nil
        pendingResult = false
        pendingPlan = nil
    }

    func handle(_ line: String) {
        guard let data = line.data(using: .utf8), let event = try? JSONDecoder().decode(Event.self, from: data) else { return }
        if event.plan == true {
            pendingPlan = event
        } else if let stage = event.stage, let text = event.text {
            if event.live == true {
                progressCompleted = event.completed
                progressTotal = event.total
                progressLabel = ["scan", "cloud scan"].contains(stage) ? "Preparing sessions" : stage == "verify" ? "Checking the move" : stage == "desktop" ? "Restarting Claude Desktop" : ["move", "retire", "rescue"].contains(stage) ? "Moving sessions" : "Finishing the move"
                badge = event.completed != nil && event.total != nil ? "\(progressLabel) \(text)" : progressLabel
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
            let failed = event.failed ?? [], problems = event.problems ?? []
            let waiting = event.waiting ?? event.held ?? []
            let pendingCloud = event.pendingCloud ?? 0
            pendingResult = event.complete == false || pendingCloud > 0 || !(event.pendingUndo ?? []).isEmpty || !waiting.isEmpty
            if !failed.isEmpty { lines.append(("issue", failed.map { identity($0.title, $0.id) + " | " + $0.error }.joined(separator: "\n"))) }
            for problem in problems { lines.append(("check", identity(problem.title, problem.id) + " | " + problem.check + " failed")) }
            if !waiting.isEmpty { lines.append(("open", waiting.map(\.title).joined(separator: "\n"))) }
            if let reason = event.reason ?? (event.ok == false ? event.note : nil) { lines.append(("reason", reason)) }
            let moved = event.moved ?? 0
            var parts: [String] = []
            if moved > 0 { parts.append(quantity(moved, "session moved", "sessions moved")) }
            if !waiting.isEmpty { parts.append("\(waiting.count) still open") }
            let issues = failed.count + problems.count
            if issues > 0 { parts.append("\(issues) need attention") }
            else if event.ok == false { parts.append("remaining work needs attention") }
            if pendingCloud > 0 && waiting.isEmpty && issues == 0 { parts.append("remaining sessions will finish when their account is available") }
            if !(event.pendingUndo ?? []).isEmpty { parts.append("sign into \(event.pendingUndo!.joined(separator: " or ")) to finish Undo") }
            if (event.keptLocal ?? 0) > 0 || (event.heldCancelled ?? 0) > 0 { parts = ["Completed moves kept, remaining work cancelled"] }
            if parts.isEmpty {
                parts = [event.restarted == true ? "Claude Desktop restarted" : event.complete == true ? "Move complete" : "Nothing to move"]
            }
            note = parts.joined(separator: ", ")
            restartAvailable = event.restart ?? false
            if !pendingResult && event.ok != false { excluded = []; from = []; to = nil; targetChosen = false; selectionComplete = true }
            notify(note, "")
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
            note = operationArgs.first == "undo" ? "Nothing to undo" : "No remaining work"
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
        if sweeping { queued = { [weak self] in self?.restartDesktop() }; return }
        guard !running else { return }
        begin()
        runOperation(["restart", "--json"])
    }

    func restoreRestartWarning() {
        skipRestartWarning = false
        UserDefaults.standard.set(false, forKey: "skipRestartWarning")
    }

    private func runOperation(_ args: [String], remember: Bool = true) {
        if remember { operationArgs = args; approvalAttempted = false }
        run(args, line: { [weak self] in self?.handle($0) }) { [weak self] status, error in self?.finish(status, error) }
    }

    private func confirmRestart(_ plan: Event) {
        guard let token = plan.token else { running = false; note = "Restart plan is missing its approval token"; return }
        var response = NSApplication.ModalResponse.alertFirstButtonReturn
        var suppress = false
        if !skipRestartWarning {
            let alert = NSAlert()
            alert.alertStyle = .warning
            alert.messageText = plan.kind == "refresh" ? "Restart Claude Desktop?" : "Restart Claude Desktop to finish moving?"
            var seen: Set<String> = []
            let names = (plan.affected ?? []).filter { seen.insert($0.recordId ?? "pid/\($0.pid)").inserted }.map { $0.title ?? "Another open Claude session" }
            alert.informativeText = "All Claude Desktop windows will close, including Chat, Cowork, and background commands. These sessions are open:\n\n" + (names.isEmpty ? "No Code sessions are open." : names.joined(separator: "\n")) + "\n\nRestart begins immediately. Any native Claude quit confirmation remains yours to answer."
            alert.addButton(withTitle: "Stop and restart")
            if plan.kind == "move" { alert.addButton(withTitle: "Move the rest") }
            alert.addButton(withTitle: "Cancel")
            alert.showsSuppressionButton = true
            alert.suppressionButton?.title = "Don't show again"
            NSApp.activate(ignoringOtherApps: true)
            response = alert.runModal()
            suppress = alert.suppressionButton?.state == .on
        }
        pendingPlan = nil
        if response == .alertFirstButtonReturn {
            if suppress { skipRestartWarning = true; UserDefaults.standard.set(true, forKey: "skipRestartWarning") }
            begin()
            approvalAttempted = true
            runOperation(operationArgs + ["--restart-approved", token], remember: false)
        } else if plan.kind == "move", response == .alertSecondButtonReturn {
            begin()
            runOperation(operationArgs + ["--move-only"], remember: false)
        } else {
            running = false
            badge = ""
            note = "Restart cancelled. No additional sessions moved."
            refresh()
        }
    }

    private func sweep() {
        guard !running, !sweeping, !snapshot else { return }
        sweeping = true
        var result: Event?
        run(["sweep", "--json"], line: { line in
            if let data = line.data(using: .utf8), let decoded = try? JSONDecoder().decode(Event.self, from: data), decoded.swept == true { result = decoded }
        }) { [weak self] status, error in
            guard let self else { return }
            sweeping = false
            defer { let next = queued; queued = nil; next?() }
            if result == nil, error.contains("another run holds the lock") { return }
            if result != nil, let sweepNote, note == sweepNote {
                note = ""
                symbol = "arrow.left.arrow.right"
            }
            if result != nil { sweepNote = nil }
            let previousNote = note
            if result == nil, status != 0 {
                lines.append(("background", error))
                note = "The remaining work needs attention"
                symbol = "exclamationmark.triangle"
            } else if let error = result?.error, !error.isEmpty {
                lines.append(("background", error))
                note = "The remaining work needs attention"
                symbol = "exclamationmark.triangle"
            } else if let changed = result?.changed, !changed.isEmpty {
                note = quantity(changed.count, "moved session changed", "moved sessions changed") + " title or archive state after the move. Snapshots are in the receipt."
                symbol = "info.circle"
            }
            if result?.ok != false, result?.restart == true {
                restartAvailable = true
                note = "Pending sessions moved. Restart Claude Desktop to refresh this account."
            }
            if note != previousNote, !note.isEmpty { sweepNote = note }
        }
    }

    nonisolated private static func capture(_ executable: String, _ arguments: [String]) -> String? {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: executable)
        process.arguments = arguments
        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = FileHandle.nullDevice
        do { try process.run() } catch { return nil }
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        guard process.terminationStatus == 0 else { return nil }
        return String(decoding: data, as: UTF8.self)
    }

    private func finish(_ status: Int32, _ error: String) {
        if let plan = pendingPlan, status == 0 {
            if approvalAttempted {
                pendingPlan = nil
                running = false
                badge = ""
                note = "Open sessions changed after approval. Click Move or Finish pending to review them again."
                symbol = "exclamationmark.triangle"
                return
            }
            confirmRestart(plan)
            return
        }
        running = false
        badge = ""
        progressCompleted = nil
        progressTotal = nil
        if !pendingResult && status == 0 { excluded = []; from = []; to = nil; targetChosen = false; selectionComplete = true }
        symbol = pendingResult ? "clock.arrow.circlepath" : status == 0 ? "checkmark" : "exclamationmark.triangle"
        if status != 0, note.isEmpty { lines.append(("reason", error)); note = "The move needs attention" }
        DispatchQueue.main.asyncAfter(deadline: .now() + 4) { [weak self] in self?.symbol = "arrow.left.arrow.right" }
        refresh()
    }

    private func notify(_ title: String, _ body: String) {
        if demo || snapshot { return }
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
        if args.first == "accounts" {
            DispatchQueue.global().asyncAfter(deadline: .now() + 60) { if process.isRunning { process.terminate() } }
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
                        if account.pending != nil { Tag(text: account.pendingFailures?.isEmpty == false ? "attention" : account.pendingAction == "sign-in" ? "sign in" : "waiting", color: .orange) }
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
                if let label = model.identityLabel { Tag(text: label, color: .gray) }
                Spacer()
                Button(action: { model.refresh() }) { Image(systemName: "arrow.clockwise") }.buttonStyle(.plain).foregroundStyle(.secondary)
            }
            accountBoard.disabled(model.running || !model.pendingAccounts.isEmpty)
            if !model.displaySummary.isEmpty { Divider() }
            if model.running {
                if let progress = model.progress { Bar(value: progress) } else { ActivityBar() }
            }
            if !model.displaySummary.isEmpty {
                Text(model.displaySummary.sentence).font(.callout.weight(.medium))
            }
            if !model.detailLines.isEmpty {
                DisclosureGroup("Details", isExpanded: $model.detailsExpanded) {
                    ScrollView {
                        VStack(alignment: .leading, spacing: 8) {
                            ForEach(Array(model.detailLines.enumerated()), id: \.offset) { item in
                                HStack(alignment: .firstTextBaseline, spacing: 8) {
                                    Text(item.element.0).foregroundStyle(.secondary).frame(width: 60, alignment: .leading)
                                    Text(item.element.1).fixedSize(horizontal: false, vertical: true)
                                }
                            }
                        }.font(.system(.caption, design: .monospaced)).frame(maxWidth: .infinity, alignment: .leading)
                    }.frame(height: 200)
                }.font(.caption)
            }
            if model.restartAvailable {
                Button(action: { model.restartDesktop() }) { Text("Restart Claude Desktop to see them").font(.callout.weight(.medium)).underline() }.buttonStyle(.plain)
            }
            HStack(spacing: 10) {
                if model.pendingAccounts.isEmpty {
                    Pill(title: "Move", prominent: true, enabled: model.ready) { model.move() }
                } else {
                    if model.pendingReady { Pill(title: model.pendingButtonTitle, prominent: true, enabled: true) { model.finishPending() } }
                    if model.canKeepLocal { Pill(title: "Keep completed", prominent: false, enabled: model.canKeepLocal) { model.keepLocal() } }
                }
                Pill(title: "Undo last", prominent: false, enabled: !model.running) { model.undo() }
                Spacer()
                Button("Quit") { NSApplication.shared.terminate(nil) }.buttonStyle(.plain).foregroundStyle(.secondary)
            }
            if model.skipRestartWarning {
                Button("Show restart warnings", action: model.restoreRestartWarning).buttonStyle(.plain).font(.caption).foregroundStyle(.secondary)
            }
        }
        .padding(16)
        .frame(width: 2 * columnWidth + Panel.gap + 32)
        .background(Color(white: 0.11))
        .onAppear { if !model.snapshot { model.panelVisibility(true) } }
        .onDisappear { if !model.snapshot { model.panelVisibility(false) } }
        .onReceive(NotificationCenter.default.publisher(for: NSWindow.didChangeOcclusionStateNotification)) { note in
            if !model.snapshot, let window = note.object as? NSWindow { model.panelVisibility(window.occlusionState.contains(.visible)) }
        }
    }

    @ViewBuilder private var accountBoard: some View {
        if model.accounts.count <= Panel.visibleRows {
            board
        } else {
            ScrollView(.vertical) { board }
                .frame(height: CGFloat(Panel.visibleRows * 34 + 18))
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
    static let visibleRows = 10

    private func column<Content: View>(_ title: String, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            Text(title.uppercased()).font(.caption2.weight(.semibold)).tracking(0.8).foregroundStyle(.secondary).padding(.bottom, 4)
            content()
        }
    }
}

enum Snapshot {
    @MainActor
    static func data(_ model: Model, size: CGSize? = nil) -> Data? {
        let panel = Panel().environmentObject(model).environment(\.colorScheme, .dark)
        let content = Group {
            if let size { panel.frame(width: size.width, height: size.height, alignment: .top) } else { panel }
        }.background(Color(white: 0.11))
        let renderer = ImageRenderer(content: content)
        renderer.scale = 2
        guard let tiff = renderer.nsImage?.tiffRepresentation else { return nil }
        return NSBitmapImageRep(data: tiff)?.representation(using: .png, properties: [:])
    }

    @MainActor
    static func write(_ model: Model, to file: String) {
        guard !model.snapshotFailed, let png = data(model) else { exit(1) }
        do { try png.write(to: URL(fileURLWithPath: file)) } catch { exit(1) }
        exit(0)
    }
}

enum Demo {
    private static let at = Date().timeIntervalSince1970 * 1000
    static let accounts = [
        Account(account: "work", org: "acme", email: "you@work.com", orgName: "Acme Inc.", label: "you@work.com · Acme Inc.", active: true, signedIn: true, activeAt: at - 2 * 3_600_000, pending: nil, pendingFailures: nil, stats: "161 | 2h ago | acme-api | active", identityState: "known"),
        Account(account: "work", org: "work-personal", email: "you@work.com", orgName: "Personal", label: "you@work.com · Personal", active: false, signedIn: true, activeAt: at - 86_400_000, pending: nil, pendingFailures: nil, stats: "157 | 1d ago | acme-api", identityState: "known"),
        Account(account: "home", org: "home-personal", email: "you@home.com", orgName: "Personal", label: "you@home.com · Personal", active: false, signedIn: false, activeAt: at - 5 * 86_400_000, pending: nil, pendingFailures: nil, stats: "3 | 5d ago | notes", identityState: "known"),
        Account(account: "work2", org: "northwind", email: "you@work2.com", orgName: "Northwind", label: "you@work2.com · Northwind", active: false, signedIn: false, activeAt: at - 4 * 60_000, pending: nil, pendingFailures: nil, stats: "12 | 4m ago | northwind", identityState: "known")
    ]

    @MainActor
    static func play(_ model: Model, into directory: String) {
        let root = URL(fileURLWithPath: directory)
        try? FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        var durations: [Int] = []
        model.selectTarget(accounts[2].id)
        model.lines = [("inventory", "318 records | 3 already there | 307 to move"), ("move", "308 ✓ | 307 zero-copy | 1 rescued"), ("verify", "transcripts unchanged ✓ | sidecars unchanged ✓ | desktop ✓")]
        model.note = "308 sessions moved"
        let size = ImageRenderer(content: Panel().environmentObject(model).environment(\.colorScheme, .dark)).nsImage?.size
        model.lines = []
        model.note = ""
        model.restartAvailable = false
        func snap(_ milliseconds: Int) {
            guard let png = Snapshot.data(model, size: size) else { exit(1) }
            try? png.write(to: root.appendingPathComponent(String(format: "frame-%03d.png", durations.count)))
            durations.append(milliseconds)
        }
        snap(1200)
        model.toggle(accounts[3].id)
        snap(1200)
        model.toggle(accounts[0].id)
        snap(900)
        model.toggle(accounts[0].id)
        snap(600)
        model.begin()
        model.lines = [("inventory", "318 records | 3 already there | 307 to move")]
        snap(300)
        model.progressLabel = "Moving sessions"
        for completed in [75, 170, 250, 308] {
            model.progressCompleted = completed
            model.progressTotal = 308
            snap(180)
        }
        model.running = false
        model.badge = ""
        model.progressCompleted = nil
        model.progressTotal = nil
        model.lines.append(("move", "308 ✓ | 307 zero-copy | 1 rescued"))
        model.lines.append(("verify", "transcripts unchanged ✓ | sidecars unchanged ✓ | desktop ✓"))
        model.symbol = "checkmark"
        model.handle("{\"done\":true,\"ok\":true,\"complete\":true,\"moved\":308,\"failed\":[],\"waiting\":[]}")
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
            let value = { (flag: String) in args.firstIndex(of: flag).flatMap { $0 + 1 < args.count ? args[$0 + 1] : nil } }
            let supplied = value("--node").flatMap { node in value("--script").map { Config(node: node, script: $0) } }
            let model = Model(snapshot: true, config: supplied)
            _model = StateObject(wrappedValue: model)
            let file = args[index + 1]
            DispatchQueue.main.async { Snapshot.write(model, to: file) }
        } else {
            _model = StateObject(wrappedValue: Model())
        }
    }

    var body: some Scene {
        MenuBarExtra {
            Panel().environmentObject(model).environment(\.controlActiveState, .key).environment(\.colorScheme, .dark)
        } label: {
            HStack(spacing: 4) {
                Image(systemName: model.symbol)
                if !model.badge.isEmpty { Text(model.badge).monospacedDigit() }
            }
        }
        .menuBarExtraStyle(.window)
    }
}
