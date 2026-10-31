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
    var receipt: String? = nil
    var receiptSummary: ReceiptSummary? = nil
    var recoveryProblem: RecoveryProblem? = nil
    var pendingState: String? = nil
    var pendingCount: Int? = nil
    var pendingAutomatic: Bool? = nil
    var pendingRetryAt: Double? = nil
    var pendingOpenCount: Int? = nil
    var pendingIdleSeconds: Int? = nil
    var pendingPartial: Bool? = nil
    var pendingCancel: String? = nil
    var kept: Bool? = nil
    var id: String { account + "/" + org }
    var selector: String { account + " " + org }
    var name: String { email ?? String(account.prefix(8)) }
    var plan: String { orgName ?? String(org.prefix(8)) }
}

struct Config: Decodable {
    let node: String
    let script: String
    var nodeArgs: [String]? = nil
    func arguments(_ args: [String]) -> [String] { (nodeArgs ?? []) + [script] + args }
}

struct Failure: Decodable {
    let id: String?
    let sessionId: String?
    let label: String?
    let title: String?
    let error: String
    var code: String? = nil
}

struct ReceiptSummary: Decodable {
    let moved: Int
    let notMoved: [Failure]
    let groups: [FailureGroup]
    let attention: [Failure]
}

struct FailureGroup: Decodable {
    let cause: String
    let records: [Failure]
}

struct RecoveryProblem: Decodable {
    let receipt: String
    let error: String
    let code: String?
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
    let receipt: String?
    let summary: ReceiptSummary?
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
    let preparatory: Bool?
    let completed: Int?
    let total: Int?
    let done: Bool?
    let ok: Bool?
    let complete: Bool?
    let moved: Int?
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
    let notMoved: [Failure]?
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
    let code: String?
    let retryable: Bool?
    let recoveryRequired: Bool?
    let destinationLabel: String?
    let sourceLabel: String?
    let sourceId: String?
    let sourceLabels: [String]?
    let heldCount: Int?
    let remainingCount: Int?
    let sessionTotal: Int?
    let partial: Bool?
    let heldAutomatic: Bool?
    let undoPartial: Bool?
    let undoRecovery: Bool?
    let activity: String?
    var issues: Int { (summary?.attention.count ?? failed?.count ?? 0) + (problems?.count ?? 0) }
}

@MainActor
struct RestartPrompt {
    let plan: Event
    var isUndo: Bool { plan.kind == "undo" || plan.undoRecovery == true }
    var title: String {
        if isUndo { return "Restart Claude to finish Undo?" }
        if plan.kind == "refresh" { return "Restart Claude?" }
        if let count = plan.heldCount, count > 0 {
            return "Restart Claude to move \(count)\((plan.moved ?? 0) > 0 ? " more" : "") \(count == 1 ? "session" : "sessions")?"
        }
        return "Restart Claude to finish the move?"
    }
    var confirm: String { isUndo ? "Restart and undo" : plan.kind == "refresh" ? "Restart Claude" : plan.kind == "recover" ? "Restart and finish" : "Restart and move" }
    var body: String {
        var seen = Set<String>()
        let names = (plan.affected ?? []).filter { seen.insert($0.recordId ?? "pid/\($0.pid)").inserted }.map { $0.title ?? "An open Claude chat" }
        let work = isUndo ? "finish Undo" : plan.kind == "refresh" ? "refresh the sidebar" : "continue the move"
        return "Claude will close, including Chat, Cowork and background commands, and stay closed while Claude Transplant finishes. It will \(work), then try to reopen Claude.\n\nThese open chats will stop:\n" + (names.isEmpty ? "No Code chats are open." : names.joined(separator: "\n")) + "\n\nIf Claude shows a quit confirmation, answer it to continue."
    }
    func alert() -> NSAlert {
        let alert = NSAlert()
        alert.alertStyle = .warning
        alert.icon = NSImage(named: NSImage.cautionName)
        alert.messageText = title
        alert.informativeText = body
        alert.addButton(withTitle: confirm)
        if plan.kind == "move" { alert.addButton(withTitle: "Move the others only") }
        alert.addButton(withTitle: "Cancel")
        alert.showsSuppressionButton = true
        alert.suppressionButton?.title = "Don't ask again"
        return alert
    }
}

extension String {
    var sentence: String { prefix(1).uppercased() + dropFirst() }
    var punctuated: String { hasSuffix(".") ? self : self + "." }
}

enum Screen: String {
    case moved, moving, restart = "needs a restart", signIn = "needs a sign-in", blocked = "can't move"
}

struct MoveProgress {
    static let storageKey = "moveProgressCosts.v2"
    static let phases = ["prepare", "cloudScan", "close", "rescan", "move", "verify", "retire", "finalize", "reopen", "cloud"]
    static let defaults: [String: Double] = ["prepare": 0.004, "cloudScan": 1, "close": 2, "rescan": 0.001, "move": 0.0015, "verify": 0.0003, "retire": 0.0002, "finalize": 0.0015, "reopen": 1, "cloud": 1]
    static let scaled: Set<String> = ["prepare", "rescan", "move", "verify", "retire", "finalize"]
    var costs = defaults
    var observed: [String: Double] = [:]
    var skipped: Set<String> = []
    var phase = "prepare"
    var started: TimeInterval = 0
    var paused: TimeInterval?
    var sessions = 0
    private(set) var hasProgress = false
    var completed: Int?
    var total: Int?
    var value = 0.0
    var restarting = false
    var remainingSessions: Int?
    var localOnly = true
    var sampled: Set<String> = []

    init(costs learned: [String: Double] = [:], now: TimeInterval = ProcessInfo.processInfo.systemUptime) {
        started = now
        for (key, value) in learned where Self.defaults[key] != nil && value.isFinite && value > 0 { costs[key] = value; sampled.insert(key) }
    }

    var percent: Int { min(99, Int(value * 100)) }
    private func units(_ key: String) -> Double { Self.scaled.contains(key) ? Double(max(1, sessions)) : 1 }
    private func duration(_ key: String) -> Double { skipped.contains(key) ? 0 : (costs[key] ?? 1) * units(key) }

    var remainingSeconds: Double? {
        guard hasProgress, paused == nil, !sampled.isEmpty else { return nil }
        let index = Self.phases.firstIndex(of: phase)!
        let fraction = completed.flatMap { done in total.map { $0 > 0 ? min(1, Double(done) / Double($0)) : 0 } } ?? 0
        let seconds = duration(phase) * (1 - fraction) + Self.phases.dropFirst(index + 1).reduce(0) { $0 + duration($1) }
        return seconds.isFinite && seconds > 0 ? seconds : nil
    }
    var detail: String {
        var parts = ["\(percent)%"]
        if let remainingSessions { parts.append("\(remainingSessions) \(remainingSessions == 1 ? "session" : "sessions") remaining") }
        if let seconds = remainingSeconds {
            parts.append(seconds < 60 ? "About \(max(1, Int(ceil(seconds))))s remaining" : "About \(Int(ceil(seconds / 60)))min remaining")
        }
        return parts.joined(separator: " · ")
    }
    mutating func sessions(total: Int, remaining: Int) {
        if localOnly { remainingSessions = min(total, max(0, remaining)) }
    }

    mutating func record(_ now: TimeInterval) {
        let elapsed = now - started
        guard hasProgress, elapsed > 0.01, !Self.scaled.contains(phase) || sessions > 0 else { return }
        let sample = elapsed / units(phase)
        observed[phase] = sample
        costs[phase] = sample
        sampled.insert(phase)
    }

    mutating func update(_ stage: String, completed count: Int?, total size: Int?, preparatory: Bool = false, now: TimeInterval = ProcessInfo.processInfo.systemUptime) {
        if stage == "desktop", !preparatory { restarting = true }
        let mapped: String
        switch stage {
        case "scan": mapped = restarting ? "rescan" : "prepare"
        case "cloud scan": mapped = restarting || Self.phases.firstIndex(of: phase)! >= 4 ? "cloud" : "cloudScan"
        case "desktop": mapped = "close"
        case "reopen": mapped = "reopen"
        case "move": mapped = "move"
        case "verify", "retire", "finalize": mapped = stage
        case "cloud": mapped = "cloud"
        default: return
        }
        let next = preparatory ? "cloudScan" : mapped
        let index = Self.phases.firstIndex(of: next)!, previous = Self.phases.firstIndex(of: phase)!
        guard index >= previous else { return }
        if next == "move", !restarting { skipped.formUnion(["close", "rescan", "reopen"]) }
        if size == 0 {
            if index > previous || !hasProgress { skipped.insert(next) }
            refresh(now)
            return
        }
        skipped.remove(next)
        if next != phase {
            record(now)
            if !hasProgress { skipped.insert(phase) }
            for missing in Self.phases[(previous + 1)..<index] { skipped.insert(missing) }
            phase = next
            started = now
        }
        hasProgress = true
        if Self.scaled.contains(next), let size { sessions = max(sessions, size) }
        completed = count
        total = size
        refresh(now)
    }

    mutating func refresh(_ now: TimeInterval = ProcessInfo.processInfo.systemUptime) {
        guard paused == nil else { return }
        let elapsed = max(0, now - started)
        let fraction: Double
        if let completed, let total, total > 0 {
            fraction = min(1, Double(completed) / Double(total))
            if completed >= 3 && elapsed > 0.01 { costs[phase] = elapsed / fraction / units(phase); sampled.insert(phase) }
        } else {
            fraction = min(0.95, elapsed / max(0.1, elapsed + duration(phase)))
        }
        let index = Self.phases.firstIndex(of: phase)!
        let before = Self.phases.prefix(index).reduce(0) { $0 + duration($1) }
        let remaining = Self.phases.reduce(0) { $0 + duration($1) }
        value = max(value, min(0.99, (before + duration(phase) * fraction) / max(0.1, remaining)))
    }

    mutating func resume(_ now: TimeInterval = ProcessInfo.processInfo.systemUptime) {
        if let paused { started += now - paused }
        paused = nil
    }
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
    @Published var completion: (summary: String, detail: String)?
    @Published var badge = ""
    @Published var symbol = "arrow.left.arrow.right"
    @Published var running = false
    @Published private(set) var sweeping = false
    @Published private(set) var sourceActivity: Event?
    private var queued: [String]?
    @Published var skipRestartWarning = UserDefaults.standard.bool(forKey: "skipRestartWarning")
    @Published var restartAvailable = false
    @Published var moveProgress = MoveProgress()
    var snapshotFailed = false
    let snapshot: Bool
    let demo: Bool
    private let config: Config?
    private var refreshing = false
    private var pendingResult = false
    private var pendingPlan: Event?
    private var operationArgs: [String] = []
    private var retryReceipt: String?
    private var operationStarted: TimeInterval?
    private var operationDestination: String?
    private var failedFinish: String?
    private var approvalAttempted = false
    private var poller: AnyCancellable?
    private var progressTimer: AnyCancellable?
    private var activeIdentity = ""
    private var targetChosen = false
    private var selectionComplete = false
    private var panelOpen = false
    private var sweepNote: String?
    private var sweepFailureReceipt: String?
    private var restartNote: String?
    private var retryable = false
    private var stopped = false
    private var reviewRestart = false
    private var forceRestartWarning = false
    private var preserveNotice = false
    private var partialResult = false
    private var recoveryBlocked = false

    init(snapshot: Bool = false, config supplied: Config? = nil) {
        self.snapshot = snapshot
        demo = false
        let file = Bundle.main.url(forResource: "menubar", withExtension: "json") ?? FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support/claude-transplant/menubar.json")
        config = supplied ?? (try? Data(contentsOf: file)).flatMap { try? JSONDecoder().decode(Config.self, from: $0) }
        if snapshot {
            guard let config, let text = Model.capture(node(config.node), config.arguments(["accounts", "--json"])), let decoded = try? JSONDecoder().decode([Account].self, from: Data(text.utf8)) else { snapshotFailed = true; return }
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
        progressTimer = Timer.publish(every: 0.2, on: .main, in: .common).autoconnect().sink { [weak self] _ in
            guard let self, self.running else { return }
            self.moveProgress.refresh()
            self.badge = "\(self.moveProgress.percent)%"
        }
    }

    init(demo accounts: [Account]) {
        snapshot = true
        demo = true
        config = nil
        skipRestartWarning = false
        self.accounts = accounts
        settle()
    }

    var identityLabel: String? { accounts.contains { $0.active == true } ? nil : accounts.first?.identityState == "logged-out" ? "signed out" : "unknown" }
    var pendingAccounts: [Account] { accounts.filter { $0.pending != nil } }
    var receiptSummaries: [ReceiptSummary] {
        var seen = Set<String>()
        return accounts.compactMap { account in
            guard let file = account.receipt, seen.insert(file).inserted else { return nil }
            return account.receiptSummary
        }
    }
    var activePendingAccount: Account? { pendingAccounts.first { $0.active == true } }
    var recoveryProblem: RecoveryProblem? { accounts.compactMap(\.recoveryProblem).first }
    var canMutate: Bool { !running && recoveryProblem == nil && !recoveryBlocked }
    var undoPending: Bool { pendingAccounts.contains { $0.pending == "undo" } }
    var hasSecondaryActions: Bool { canKeepLocal || !undoPending }
    var directActions: Bool { screen == .blocked }
    var canKeepLocal: Bool { canMutate && (partialResult || pendingAccounts.contains { ["cloud", "local", "partial"].contains($0.pending ?? "") }) }
    var pendingReady: Bool { canMutate && pendingAccounts.contains { ["finish", "restart"].contains($0.pendingAction ?? ($0.pending == "local" || $0.pending == "recovery" || $0.pending == "undo" && $0.signedIn == true ? "finish" : "wait")) } && (config != nil || demo) }
    var pendingButtonTitle: String {
        if reviewRestart { return restartReviewTitle }
        if pendingAccounts.contains(where: { $0.pendingAction == "restart" }) {
            let count = pendingAccounts.filter { $0.pending == "local" }.compactMap(\.pendingCount).reduce(0, +)
            return count > 0 ? "Restart Claude and move \(count)" : pendingAccounts.contains(where: { $0.pending == "local" }) ? "Restart Claude and move" : "Restart Claude and finish cleanup"
        }
        if pendingAccounts.contains(where: { $0.pending == "undo" }) { return "Finish undo" }
        return "Finish the move"
    }
    var ready: Bool { canMutate && pendingAccounts.isEmpty && !from.isEmpty && to != nil && (config != nil || demo) }
    private var pendingMoved: Int { max(sourceActivity?.moved ?? 0, receiptSummaries.isEmpty ? pendingAccounts.compactMap(\.receiptMoved).max() ?? 0 : receiptSummaries.reduce(0) { $0 + $1.moved }) }
    var pendingPrompt: String {
        guard !pendingAccounts.isEmpty || receiptSummaries.contains(where: { !$0.notMoved.isEmpty }) else { return "" }
        if pendingAccounts.contains(where: { $0.pending == "recovery" }) { return "The last move was interrupted." }
        let moved = pendingMoved
        let notMoved = receiptSummaries.reduce(0) { $0 + $1.notMoved.count }
        let parts = pendingAccounts.map(pendingText)
        let prefix = moved > 0 && !pendingAccounts.contains(where: { $0.pending == "undo" }) ? "\(moved) moved. " : ""
        if !parts.isEmpty { return prefix + parts.joined(separator: " ") + (notMoved > 0 && !pendingAccounts.contains(where: { $0.pending == "partial" }) ? " " + quantity(notMoved, "session was not moved.", "sessions were not moved.") : "") }
        return prefix + (notMoved > 0 ? quantity(notMoved, "session was not moved.", "sessions were not moved.") : "Remaining sessions are ready to move.")
    }
    private func pendingText(_ account: Account) -> String {
        let count = account.pendingCount
        let amount = count.map(String.init) ?? "Remaining"
        let copies = count.map { quantity($0, "old copy", "old copies") } ?? "Old copies"
        let conversations = count.map { quantity($0, "conversation", "conversations") } ?? "Conversations"
        let signInText = "Sign Claude in as \(account.email ?? account.label)"
        let seconds = account.pendingRetryAt.map { max(0, Int(ceil($0 / 1000 - Date().timeIntervalSince1970))) }
        let retry = seconds.map { $0 > 0 ? " Retrying in \($0)s." : " Checking again shortly." } ?? " The check will retry automatically."
        if account.pending == "undo" {
            return account.pendingAction == "finish" ? "Press Finish undo." : signInText.punctuated
        }
        switch account.pendingState {
        case "interrupted": return "The last move was interrupted. Finish it to continue."
        case "login": return account.signedIn == true ? "Waiting for Claude to finish signing in." + retry : signInText + " to continue."
        case "memory": return "Waiting for memory to verify history." + retry
        case "limit": return "\(conversations) \(count == 1 ? "exceeds" : "exceed") the history limit of 1,000,000 events and \(count == 1 ? "remains" : "remain") in \(account.label)."
        case "budget-limit": return "\(conversations) could not fit the operation's memory budget, even one at a time. \(count == 1 ? "It remains" : "They remain") in \(account.label)."
        case "parser-limit": return "\(conversations) exceeded the history reader's limit and \(count == 1 ? "remains" : "remain") in \(account.label)."
        case "unproven": return "\(copies) \(count == 1 ? "stays" : "stay") in \(account.label). \(count == 1 ? "It is" : "They are") not proven to be on this Mac."
        case "partial": return "\(amount) \(count == 1 ? "session remains" : "sessions remain") in \(account.label). Keep moved sessions or undo this move. See Details for titles and reasons."
        case "external": return "Waiting for external Claude sessions to stop before moving \(amount.lowercased()) remaining sessions."
        case "waiting": return "Waiting to verify \(conversations.lowercased()) in \(account.label)".punctuated + (account.signedIn == true ? retry : " \(signInText) and the check will retry automatically.")
        case "cloud-open": return "\(copies) in \(account.label) \(count == 1 ? "is" : "are") still connected. Cleanup waits for \(count == 1 ? "it" : "them") to disconnect." + (account.signedIn == true ? "" : " \(signInText) to continue.")
        case "open" where account.pendingAutomatic == true:
            if let seconds = account.pendingIdleSeconds, seconds > 0 {
                let duration = seconds % 60 == 0 ? quantity(seconds / 60, "idle minute", "idle minutes") : quantity(seconds, "idle second", "idle seconds")
                return "\(amount) open \(count == 1 ? "chat can" : "chats can") move after about \(duration), or now with a restart."
            }
            if let open = account.pendingOpenCount, open != count { return "\(amount) remaining sessions can move after \(quantity(open, "open chat goes", "open chats go")) idle, or now with a restart." }
            return "\(amount) open \(count == 1 ? "chat moves" : "chats move") after \(count == 1 ? "it goes" : "they go") idle, or now with a restart."
        case "held", "open": return account.pendingAction == "finish" ? "\(amount) remaining \(count == 1 ? "session is" : "sessions are") ready to move." : count.map { "\($0) more \($0 == 1 ? "needs" : "need") Claude to restart." } ?? "The remaining sessions need Claude to restart."
        default:
            let status = count == nil ? "Source history in \(account.label) still needs checking." : "\(copies) \(count == 1 ? "needs" : "need") checking in \(account.label)".punctuated
            return status + (account.signedIn == true ? account.pendingRetryAt == nil ? " Cleanup will retry automatically." : retry : " \(signInText) and cleanup will retry automatically.")
        }
    }
    var primaryTitle: String? {
        guard canMutate else { return nil }
        if stopped && !operationArgs.isEmpty && continuationArgs.isEmpty { return nil }
        if reviewRestart && !operationArgs.isEmpty { return restartReviewTitle }
        if retryable && !operationArgs.isEmpty { return "Try again" }
        if !pendingAccounts.isEmpty { return pendingReady ? pendingButtonTitle : nil }
        if partialResult { return nil }
        return !pendingResult && !stopped && ready ? "Move" : nil
    }
    func primary() {
        if stopped && !operationArgs.isEmpty && continuationArgs.isEmpty { return }
        if reviewRestart || retryable { guard canMutate, !continuationArgs.isEmpty else { return }; start(continuationArgs) }
        else if !pendingAccounts.isEmpty { finishPending() }
        else { move() }
    }
    var scopedChecks: [String] {
        let eligible = pendingAccounts.filter { ($0.pendingCount ?? 0) > 0 && $0.pendingAction == "blocked" && $0.pending == "cloud" }
        return eligible.compactMap(\.pendingCancel)
    }
    func stopHere() {
        guard canKeepLocal else { return }
        if scopedChecks.isEmpty { keepLocal() }
        else { start(["keep-local", "--json"] + scopedChecks.flatMap { ["--leave-check", $0] }) }
    }
    func sourceTag(_ account: Account) -> String? {
        if let event = sourceActivity, event.sourceId == account.id { return (event.activity ?? event.stage) == "cloud" ? "clearing" : "checking" }
        if account.kept == true { return "kept" }
        guard account.pending != nil else { return nil }
        if account.pendingState == "partial" { return "not moved" }
        if account.pendingAction == "blocked" { return "kept" }
        if account.pendingState == "login", account.signedIn == true { return "signing in" }
        if account.pendingState == "open" && account.pendingAutomatic == true { return "waiting" }
        if account.pendingAction == "restart" { return "restart needed" }
        if account.pendingAction == "sign-in" { return "sign in needed" }
        return "waiting"
    }
    var detailLines: [(String, String)] {
        let recovery = recoveryProblem.map { $0.code == "OLDER_MOVE" ? [("receipt", $0.receipt)] : [("recovery", $0.error.sentence), ("receipt", $0.receipt), ("after repair", "Run claude-transplant finish after correcting the conflict.")] } ?? []
        let next = pendingAccounts.filter { $0.id != statusAccount?.id }.map { ("next", pendingText($0)) }
        if !lines.isEmpty { return recovery + lines }
        if !receiptSummaries.isEmpty { return recovery + next + receiptSummaries.flatMap(summaryLines) + pendingAccounts.flatMap { ($0.pendingWaiting ?? []).map { ("open", $0.title) } } }
        return recovery + next + pendingAccounts.flatMap { account in
            (account.pendingWaiting ?? []).map { ("open", $0.title) } +
            (account.pendingFailures ?? []).map { ("issue", identity($0.title, $0.id) + " | " + $0.error) }
        }
    }
    var screen: Screen? {
        if running { return .moving }
        if recoveryProblem != nil || recoveryBlocked { return .blocked }
        if reviewRestart || retryable { return .restart }
        if let first = [Screen.restart, .blocked, .signIn, .moved].first(where: pendingAccounts.map(screen).contains) { return first }
        if partialResult || stopped || !receiptSummaries.allSatisfy({ $0.notMoved.isEmpty }) && note.isEmpty { return .blocked }
        return displaySummary.isEmpty ? nil : .moved
    }
    private var statusAccount: Account? { pendingAccounts.first(where: { screen($0) == screen }) ?? activePendingAccount ?? pendingAccounts.first }
    private func screen(_ account: Account) -> Screen {
        if account.pending == "partial" || account.pendingAction == "blocked" { return .blocked }
        if account.pending == "undo" { return account.pendingState == "undo-login" ? .signIn : .restart }
        if account.pendingAction == "sign-in" { return .signIn }
        return account.pending == "cloud" && account.pendingAction == "wait" ? .moved : .restart
    }
    var displaySummary: String { recoveryProblem != nil ? "The last move is paused." : running ? progressLabel : sourceActivity.flatMap(sourceProgressText) ?? (note.isEmpty ? pendingPrompt : note) }
    var statusDetail: String? {
        if let problem = recoveryProblem { return problem.error.sentence.punctuated }
        guard !running, !stopped, !reviewRestart,
              note.isEmpty || note == pendingPrompt || sourceActivity != nil else { return nil }
        guard let account = statusAccount else { return nil }
        if let event = sourceActivity, let text = sourceProgressText(event) {
            let prefix = "\(event.moved ?? 0) moved. "
            return text.hasPrefix(prefix) ? String(text.dropFirst(prefix.count)) : text
        }
        return pendingText(account)
    }
    var statusHeadline: String {
        if recoveryProblem != nil || statusDetail == nil { return displaySummary }
        if undoPending { return pendingAccounts.contains { $0.pendingPartial == true } ? "Undo is partly done" : "Undo is waiting" }
        return pendingMoved > 0 ? quantity(pendingMoved, "session moved", "sessions moved") : "No sessions moved yet"
    }
    var visibleCompletion: (summary: String, detail: String)? {
        canMutate && completion?.summary == note ? completion : nil
    }

    func canSource(_ account: Account) -> Bool { account.id != to }

    func toggle(_ id: String) {
        guard !running, let account = accounts.first(where: { $0.id == id }), canSource(account) else { return }
        if selectionComplete { excluded = Set(accounts.map(\.id)) }
        clearResult()
        if from.contains(id) { excluded.insert(id) } else { excluded.remove(id) }
        settle()
    }

    func selectTarget(_ id: String) {
        guard !running else { return }
        if from.isEmpty { excluded = [] }
        clearResult()
        if let old = to, old != id, let vacated = lanes.first(where: { $0.value == old })?.key, let taken = lanes.first(where: { $0.value == id })?.key {
            lanes[vacated] = id
            lanes[taken] = old
        }
        to = id
        targetChosen = true
        settle()
    }

    func reset() {
        guard !running, pendingAccounts.isEmpty else { return }
        clearResult()
        from = []
        to = nil
        excluded = []
        lanes = [:]
        targetChosen = true
        selectionComplete = true
        symbol = "arrow.left.arrow.right"
        badge = ""
        refresh()
    }

    private func settle() {
        if let selected = to, !accounts.contains(where: { $0.id == selected }) {
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
        from = !pendingAccounts.isEmpty ? Set(pendingAccounts.filter(canSource).map(\.id)) : selectionComplete ? [] : Set(accounts.filter(canSource).map(\.id)).subtracting(excluded)
    }

    func panelVisibility(_ visible: Bool) {
        panelOpen = visible
        if visible { refresh() }
    }

    private func clearResult() {
        failedFinish = nil
        sweepFailureReceipt = nil
        restartNote = nil
        retryReceipt = nil
        pendingResult = false
        sourceActivity = nil
        selectionComplete = false
        lines = []
        detailsExpanded = false
        note = ""
        completion = nil
        if restartAvailable && symbol == "info.circle" { symbol = "arrow.left.arrow.right" }
        restartAvailable = false
        retryable = false
        stopped = false
        reviewRestart = false
        forceRestartWarning = false
        preserveNotice = false
        partialResult = false
        recoveryBlocked = false
    }

    func refresh() {
        guard !refreshing, !running, !sweeping else { return }
        refreshing = true
        var text = ""
        run(["accounts", "--json"], line: { text += $0 }) { [weak self] status, _ in
            guard let self else { return }
            refreshing = false
            guard status == 0, let data = text.data(using: .utf8), let list = try? JSONDecoder().decode([Account].self, from: data) else { return }
            accounts = list
            recoveryBlocked = list.contains { $0.recoveryProblem != nil }
            settle()
            if !pendingAccounts.isEmpty && !preserveNotice {
                completion = nil
                badge = ""
                let recovering = pendingAccounts.contains { ["recovery", "undo"].contains($0.pending ?? "") }
                if recovering || !restartAvailable && symbol != "exclamationmark.triangle" { note = ""; symbol = "clock.arrow.circlepath" }
            }
            let identity = list.filter { $0.active == true }.map(\.id).joined(separator: ",")
            let changed = identity != activeIdentity
            activeIdentity = identity
            if !snapshot && (changed || panelOpen || !pendingAccounts.isEmpty) { sweep() }
        }
    }

    func move() {
        guard ready, let target = accounts.first(where: { $0.id == to }) else { return }
        let args = accounts.filter { from.contains($0.id) }.flatMap { ["--from", $0.selector] } + ["--to", target.selector, "--cloud", "--json"]
        start(args)
    }

    func undo() {
        guard canMutate, !undoPending else { return }
        start(["undo", "--json"])
    }

    func finishPending() {
        guard pendingReady else { return }
        start(["finish", "--json"])
    }

    func keepLocal() {
        guard canKeepLocal else { return }
        start(["keep-local", "--json"])
    }

    func begin(resetProgress: Bool = true) {
        failedFinish = nil
        sweepFailureReceipt = nil
        restartNote = nil
        retryReceipt = nil
        sourceActivity = nil
        lines = []
        detailsExpanded = false
        note = ""
        completion = nil
        running = true
        restartAvailable = false
        retryable = false
        stopped = false
        forceRestartWarning = forceRestartWarning || reviewRestart
        reviewRestart = false
        preserveNotice = false
        partialResult = false
        recoveryBlocked = false
        symbol = "arrow.triangle.2.circlepath"
        progressLabel = "Preparing sessions"
        if resetProgress {
            operationStarted = nil
            operationDestination = accounts.first(where: { $0.id == to })?.label
            let costs = UserDefaults.standard.dictionary(forKey: MoveProgress.storageKey) as? [String: Double] ?? [:]
            moveProgress = MoveProgress(costs: demo || snapshot ? [:] : costs)
        }
        moveProgress.localOnly = true
        badge = "\(moveProgress.percent)%"
        pendingResult = false
        pendingPlan = nil
    }

    func handle(_ line: String) {
        guard let data = line.data(using: .utf8), let event = try? JSONDecoder().decode(Event.self, from: data) else { return }
        if event.plan == true {
            pendingPlan = event
        } else if let stage = event.stage, let text = event.text {
            if event.live == true {
                if stage == "sessions" {
                    if let total = event.sessionTotal, let remaining = event.remainingCount, total >= 0, remaining >= 0, remaining <= total {
                        moveProgress.sessions(total: total, remaining: remaining)
                    }
                    return
                }
                if (event.activity ?? stage) == "cloud scan", (event.total ?? 0) > 0 {
                    moveProgress.localOnly = false
                    moveProgress.remainingSessions = nil
                }
                updateSourceActivity(event)
                moveProgress.update(stage, completed: event.completed, total: event.total, preparatory: event.preparatory == true)
                progressLabel = event.preparatory == true ? (["move", "retire", "finalize"].contains(stage) ? "Moving eligible sessions" : stage == "verify" ? "Checking moved sessions" : "Checking remaining sessions") : ["scan", "cloud scan"].contains(stage) ? "Preparing sessions" : stage == "verify" ? "Checking the move" : ["desktop", "reopen"].contains(stage) ? "Restarting Claude Desktop" : ["move", "retire"].contains(stage) ? "Moving sessions" : "Finishing the move"
                if event.preparatory != true, let text = sourceProgressText(event) { progressLabel = text }
                badge = "\(moveProgress.percent)%"
            } else {
                lines.removeAll { $0.0 == stage }
                lines.append((stage, text))
            }
        } else if let reconciled = event.reconciled, event.code != "LOCAL_RECOVERY_BLOCKED" {
            lines = [("recovered", reconciled.title + " | " + reconciled.error)]
            note = "The interrupted operation was checked. " + (event.retry == true ? "Press Undo this move to continue." : "Press Finish the move to continue.")
            restartAvailable = false
        } else if event.done == true {
            retryReceipt = event.receipt
            let waiting = event.waiting ?? event.held ?? []
            let pendingCloud = event.pendingCloud ?? 0
            pendingResult = event.complete == false || event.recoveryRequired == true || (event.heldCount ?? 0) > 0 || pendingCloud > 0 || !(event.pendingUndo ?? []).isEmpty || !waiting.isEmpty
            recordIssues(event)
            if !waiting.isEmpty { lines.append(("open", waiting.map(\.title).joined(separator: "\n"))) }
            if let reason = event.reason ?? (event.ok == false ? event.note : nil) { lines.append(("reason", reason)) }
            let moved = event.summary?.moved ?? event.moved ?? 0
            let notMoved = event.summary?.notMoved.count ?? event.notMoved?.count ?? 0
            let prefix = moved > 0 ? "\(moved) moved. " : ""
            let issues = event.issues
            recoveryBlocked = event.code == "LOCAL_RECOVERY_BLOCKED"
            partialResult = event.partial == true
            retryable = event.retryable == true
            stopped = event.ok == false
            if ["RESTART_PLAN_CHANGED", "RESTART_APPROVAL_CHANGED"].contains(event.code ?? "") {
                changedApproval()
            } else if event.code == "REOPEN_FAILED" {
                reopenFailure()
            } else if event.code == "QUIT_UNCONFIRMED" {
                note = prefix + "\(operationName) stopped: \(plainReason(event.code))."
                preserveNotice = true
            } else if event.recoveryRequired == true {
                note = prefix + (notMoved > 0 ? quantity(notMoved, "session remains.", "sessions remain.") + " " : "") + (event.reason ?? "The last move was interrupted. Check Details before continuing.")
            } else if !(event.pendingUndo ?? []).isEmpty {
                note = (event.undoPartial == true ? "Undo is partly done." : "Undo is waiting.") + " Sign Claude into \(event.pendingUndo!.joined(separator: " or ")), then press Finish undo."
            } else if event.keptLocal != nil || event.heldCancelled != nil {
                note = prefix + "Stopped here. Remaining \(operationArgs.contains("--leave-check") ? "source checks" : "work") cancelled."
            } else if let held = event.heldCount, held > 0 {
                note = prefix + (event.heldAutomatic == true ? "\(held) open \(held == 1 ? "chat moves after it goes" : "chats move after they go") idle, or now with a restart." : "\(held) more \(held == 1 ? "needs" : "need") Claude to restart.")
            } else if pendingCloud > 0 {
                note = pendingPrompt.isEmpty ? prefix + "Checking the remaining source conversations." : pendingPrompt
            } else if event.partial == true {
                note = prefix + quantity(notMoved, "session remains.", "sessions remain.") + " Keep moved sessions or undo this move. See Details for titles and reasons."
            } else if issues > 0 || event.ok == false && notMoved == 0 {
                note = "\(operationName) stopped: \(plainReason(event.code))."
            } else if notMoved > 0 {
                note = prefix + quantity(notMoved, "session was not moved.", "sessions were not moved.")
            } else {
                note = event.restarted == true && moved == 0 ? "Claude restarted." : event.complete == true ? prefix + "The move is complete." : pendingResult ? prefix + "Remaining work is waiting." : moved > 0 ? "\(moved) moved." : "Nothing to move."
            }
            if event.ok == true, event.complete == true, moved > 0, notMoved == 0, issues == 0, !pendingResult, event.keptLocal == nil, event.heldCancelled == nil {
                if let destination = event.destinationLabel ?? operationDestination ?? accounts.first(where: { $0.id == to })?.label {
                    note = "Done. \(quantity(moved, "session", "sessions")) \(moved == 1 ? "is" : "are") now in \(destination)\(destination.hasSuffix(".") ? "" : ".")"
                } else { note = "Done. \(quantity(moved, "session moved.", "sessions moved."))" }
                completion = (note, "History verified")
            }
            restartAvailable = event.code == "REOPEN_FAILED" ? false : event.restart ?? false
            if !pendingResult && event.ok != false { excluded = []; from = []; to = nil; targetChosen = false; selectionComplete = true }
            notify(note, "")
        } else if event.undone != nil {
            restartAvailable = event.restart ?? false
            let restored = event.restored ?? 0
            let cloudRestored = event.cloudRestored ?? 0
            note = "Undo complete." + (restored > 0 ? " \(quantity(restored, "source entry restored.", "source entries restored."))" : cloudRestored > 0 ? " \(quantity(cloudRestored, "old copy restored.", "old copies restored."))" : "")
            pendingResult = false
            notify(cloudRestored > 0 ? quantity(cloudRestored, "cloud mirror restored", "cloud mirrors restored") : restored > 0 ? quantity(restored, "source entry restored", "source entries restored") : quantity(event.sessions ?? 0, "session undone", "sessions undone"), event.note ?? "")
        } else if let refused = event.refused {
            note = operationArgs.first == "keep-local" ? "Remaining work could not be cancelled. Check Details." : "Undo stopped. The move's records need checking."
            restartAvailable = false
            lines = refused.map { ("kept", $0) }
            if let reason = event.reason { lines.append(("reason", reason)) }
        } else if event.nothing == true {
            recordIssues(event)
            let refused = event.summary?.notMoved.count ?? event.failed?.count ?? 0, unverified = event.problems?.count ?? 0
            note = [refused > 0 ? quantity(refused, "session was not moved", "sessions were not moved") : nil,
                    unverified > 0 ? quantity(unverified, "verification problem", "verification problems") : nil].compactMap { $0 }.joined(separator: ", ")
            if note.isEmpty { note = operationArgs.first == "undo" ? "Nothing to undo" : "No remaining work" }
            restartAvailable = false
        }
    }

    private func plainReason(_ code: String?) -> String {
        switch code {
        case "MOVE_STALLED": return "the move stopped making progress"
        case "QUIT_UNCONFIRMED": return "Claude did not confirm it had closed"
        case "REOPEN_FAILED": return "Claude could not be confirmed open"
        case "RESTART_EXTERNAL_WORKER": return "an external Claude session is still running"
        case "LOCAL_VERIFICATION_FAILED": return "the moved history needs verification"
        case "MOVE_BLOCKED": return "the remaining sessions could not be moved"
        default: return "the operation did not complete"
        }
    }
    private var operationName: String { operationArgs.first == "undo" || pendingAccounts.contains(where: { $0.pending == "undo" }) ? "Undo" : operationArgs.first == "restart" ? "Restart" : operationArgs.first == "keep-local" ? "Stopping here" : "Move" }
    private var restartReviewTitle: String { operationName == "Undo" ? "Restart Claude and finish Undo" : operationName == "Restart" ? "Restart Claude" : "Restart Claude and move" }

    private var continuationArgs: [String] {
        let args = operationArgs.indices.filter { operationArgs[$0] != "--restart-approved" && ($0 == 0 || operationArgs[$0 - 1] != "--restart-approved") }.map { operationArgs[$0] }
        let pending = Set(pendingAccounts.compactMap(\.receipt))
        guard let receipt = retryReceipt ?? (pending.count == 1 ? pending.first : nil) else { return args }
        let current = Set(accounts.compactMap(\.receipt))
        guard current.isEmpty || current == [receipt] else { return [] }
        return args.contains("--from") ? ["finish", "--json"] : args
    }

    private func reopenFailure() {
        retryable = true
        stopped = true
        preserveNotice = true
        restartAvailable = false
        note = "\(operationName) stopped: Claude could not be confirmed open. Open Claude, then press Try again."
    }

    private func updateSourceActivity(_ event: Event) {
        sourceActivity = event.live == true && event.preparatory != true && event.sourceId != nil && (event.completed ?? 0) < (event.total ?? 0) ? event : nil
        if sourceActivity != nil { lines = lines.map { ($0.0 == "background" ? "previous check" : $0.0, $0.1) } }
    }

    private func sourceProgressText(_ event: Event) -> String? {
        guard let source = event.sourceLabel else { return nil }
        let stage = event.activity ?? event.stage
        guard stage == "cloud" else { return event.sourceId == nil ? nil : "Checking source history in \(source)".punctuated }
        let remaining = max(0, (event.total ?? 0) - (event.completed ?? 0))
        let prefix = (event.moved ?? 0) > 0 ? "\(event.moved!) moved. " : ""
        return remaining == 0 ? "Finishing source checks" : prefix + "Clearing \(quantity(remaining, "old copy", "old copies")) from \(source)."
    }

    private func changedApproval() {
        reviewRestart = true
        forceRestartWarning = true
        stopped = true
        preserveNotice = true
        note = "Different chats are open now. Press \(restartReviewTitle) to review again."
    }

    private func recordIssues(_ event: Event) {
        if let summary = event.summary { lines += summaryLines(summary) }
        else {
            if let notMoved = event.notMoved, !notMoved.isEmpty { lines.append(("not moved", notMoved.map { identity($0.title, $0.id) + " | " + $0.error }.joined(separator: "\n"))) }
            if let failed = event.failed, !failed.isEmpty { lines.append(("issue", failed.map { identity($0.title, $0.id) + " | " + $0.error }.joined(separator: "\n"))) }
        }
        for problem in event.problems ?? [] { lines.append(("check", identity(problem.title, problem.id) + " | " + problem.check + " verification failed")) }
    }

    private func summaryLines(_ summary: ReceiptSummary) -> [(String, String)] {
        summary.groups.map { ($0.cause, $0.records.map { [ $0.label, identity($0.title, $0.sessionId.map { String($0.dropFirst(6)) } ?? $0.id), $0.error ].compactMap { $0 }.joined(separator: " | ") }.joined(separator: "\n")) } +
        summary.attention.map { ("issue", identity($0.title, $0.id) + " | " + $0.error) }
    }

    private func identity(_ title: String?, _ id: String?) -> String {
        [title, id.map { String($0.prefix(8)) }].compactMap { $0 }.joined(separator: " | ")
    }

    private func quantity(_ value: Int, _ singular: String, _ plural: String) -> String {
        "\(value) \(value == 1 ? singular : plural)"
    }

    func restartDesktop() {
        guard canMutate else { return }
        start(["restart", "--json"])
    }

    func restoreRestartWarning() {
        skipRestartWarning = false
        UserDefaults.standard.set(false, forKey: "skipRestartWarning")
    }

    private func start(_ args: [String]) {
        begin()
        if sweeping {
            queued = args
            progressLabel = "Waiting for background check"
            moveProgress.paused = ProcessInfo.processInfo.systemUptime
        } else {
            runOperation(args)
        }
    }

    private func runOperation(_ args: [String], remember: Bool = true) {
        if remember { operationArgs = args; approvalAttempted = false; operationStarted = ProcessInfo.processInfo.systemUptime }
        run(args, line: { [weak self] in self?.handle($0) }) { [weak self] status, error in self?.finish(status, error) }
    }

    private func confirmRestart(_ plan: Event) {
        guard let token = plan.token else { running = false; note = "Restart plan is missing its approval token"; return }
        moveProgress.paused = ProcessInfo.processInfo.systemUptime
        var response = NSApplication.ModalResponse.alertFirstButtonReturn
        var suppress = false
        let prompt = RestartPrompt(plan: plan)
        if !skipRestartWarning || forceRestartWarning { (response, suppress) = restartResponse(prompt) }
        pendingPlan = nil
        forceRestartWarning = false
        if let paused = moveProgress.paused, let started = operationStarted { operationStarted = started + ProcessInfo.processInfo.systemUptime - paused }
        moveProgress.resume()
        if response == .alertFirstButtonReturn {
            if suppress { skipRestartWarning = true; UserDefaults.standard.set(true, forKey: "skipRestartWarning") }
            begin(resetProgress: false)
            approvalAttempted = true
            runOperation(operationArgs + ["--restart-approved", token], remember: false)
        } else if plan.kind == "move", response == .alertSecondButtonReturn {
            begin(resetProgress: false)
            runOperation(operationArgs + ["--move-only"], remember: false)
        } else {
            cancelRestart(plan)
        }
    }

    private func restartResponse(_ prompt: RestartPrompt) -> (NSApplication.ModalResponse, Bool) {
        let alert = prompt.alert()
        NSApp.activate(ignoringOtherApps: true)
        let response = alert.runModal()
        return (response, alert.suppressionButton?.state == .on)
    }

    private func cancelRestart(_ plan: Event) {
        running = false
        badge = ""
        preserveNotice = true
        let amount = plan.remainingCount.map { quantity($0, "session", "sessions") } ?? "The remaining sessions"
        let source = (plan.sourceLabels ?? []).joined(separator: " and ")
        note = plan.kind == "refresh" ? "Restart cancelled." : plan.kind == "recover" || plan.kind == "undo"
            ? "Restart cancelled. \(plan.kind == "undo" || plan.undoRecovery == true ? "Undo" : "The interrupted move") is still waiting\(source.isEmpty ? "" : " for " + source)."
            : "Restart cancelled. \(amount) still \(plan.remainingCount == 1 ? "needs" : "need") moving\(source.isEmpty ? "" : " from " + source)."
        refresh()
    }

    private func sweep() {
        guard canMutate, !sweeping, !snapshot else { return }
        sweeping = true
        var result: Event?
        run(["sweep", "--json"], line: { [weak self] line in
            guard let data = line.data(using: .utf8), let decoded = try? JSONDecoder().decode(Event.self, from: data) else { return }
            if decoded.stage != nil && decoded.live == true { self?.updateSourceActivity(decoded) }
            else if decoded.swept == true || decoded.code != nil { result = decoded }
        }) { [weak self] status, error in
            guard let self else { return }
            sweeping = false
            sourceActivity = nil
            defer {
                if let args = queued {
                    queued = nil
                    moveProgress.resume()
                    progressLabel = "Preparing sessions"
                    runOperation(args)
                }
            }
            if result?.code == "LOCK_BUSY" { return }
            let problem = result?.error.flatMap { $0.isEmpty ? nil : $0 } ?? (status != 0 || result?.ok != true ? (error.isEmpty ? "Background check did not complete" : error) : nil)
            let clean = problem == nil && result?.issues == 0
            let resolvedRestartError = restartAvailable && clean && result?.complete == true && canMutate && pendingAccounts.isEmpty && (result?.changed ?? []).isEmpty &&
                result?.receipt != nil && result?.receipt == sweepFailureReceipt && failedFinish == nil && !preserveNotice
            if clean, result?.complete == true, !restartAvailable || resolvedRestartError { lines.removeAll { ["background", "previous check"].contains($0.0) } }
            if clean, !restartAvailable, failedFinish == nil || result?.receipt == failedFinish && result?.complete == true && pendingAccounts.isEmpty && (result?.changed ?? []).isEmpty, let sweepNote, note == sweepNote {
                note = ""
                symbol = "arrow.left.arrow.right"
                self.sweepNote = nil
            }
            if result != nil { lines.removeAll { $0.0 == "metadata" } }
            let previousNote = note
            if let problem {
                sweepFailureReceipt = result?.receipt
                lines.removeAll { ["background", "previous check"].contains($0.0) }
                lines.append(("background", problem))
                note = pendingAccounts.contains(where: { ["waiting", "login", "memory"].contains($0.pendingState ?? "") }) ? "" : "The remaining work needs attention"
                symbol = "exclamationmark.triangle"
                if result?.code == "REOPEN_FAILED" {
                    failedFinish = result?.receipt ?? failedFinish ?? pendingAccounts.first?.receipt
                    retryReceipt = failedFinish
                    operationArgs = ["finish", "--json"]
                    reopenFailure()
                }
            } else if let changed = result?.changed, !changed.isEmpty {
                let unavailable = changed.filter { $0.fields.contains("record unavailable") }
                if !unavailable.isEmpty { sweepFailureReceipt = nil }
                let names = ["title": "title", "isArchived": "archive state", "isStarred": "starred state"]
                let fields = Set(changed.flatMap(\.fields)).sorted().map { names[$0] ?? $0 }.joined(separator: ", ")
                note = unavailable.isEmpty
                    ? quantity(changed.count, "moved session changed", "moved sessions changed") + " " + fields + ". Snapshots are in the receipt."
                    : quantity(unavailable.count, "moved session record cannot be read", "moved session records cannot be read") + ". Check Details."
                symbol = unavailable.isEmpty ? "info.circle" : "exclamationmark.triangle"
                lines.append(("metadata", changed.map { self.identity($0.title, $0.id) + " | " + $0.fields.map { names[$0] ?? $0 }.joined(separator: ", ") }.joined(separator: "\n")))
            }
            if resolvedRestartError {
                sweepFailureReceipt = nil
                symbol = "info.circle"
                note = restartNote ?? "The source checks finished. Restart Claude to refresh the sidebar."
            }
            if problem == nil, result?.restart == true, result?.changed?.contains(where: { $0.fields.contains("record unavailable") }) != true {
                restartAvailable = true
                if !running {
                    badge = ""
                    if symbol != "exclamationmark.triangle" { symbol = "info.circle" }
                }
                note = (result?.moved ?? 0) > 0 ? "Moved \(quantity(result!.moved!, "more session", "more sessions")). Restart Claude to see them." : "The source checks finished. Restart Claude to refresh the sidebar."
                restartNote = note
                if result?.complete == true && !running { selectionComplete = true; from = []; to = nil }
            }
            if clean, let failedFinish, result?.receipt == failedFinish, result?.complete == true,
               (result?.changed ?? []).isEmpty, pendingAccounts.isEmpty, !restartAvailable {
                clearResult()
                pendingResult = false
                selectionComplete = true
                note = "No remaining work"
                symbol = "arrow.left.arrow.right"
                settle()
            }
            if result?.code != "REOPEN_FAILED", let summary = result?.summary, !summary.notMoved.isEmpty, (result?.changed ?? []).isEmpty {
                lines = summaryLines(summary) + lines.filter { ["background", "metadata"].contains($0.0) }
                if !restartAvailable { note = pendingAccounts.isEmpty ? "\(summary.moved) moved. " + quantity(summary.notMoved.count, "session was not moved.", "sessions were not moved.") : pendingPrompt }
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
                changedApproval()
                symbol = "exclamationmark.triangle"
                return
            }
            confirmRestart(plan)
            return
        }
        failedFinish = status != 0 && (retryReceipt != nil && operationArgs.contains("--from") || continuationArgs.first == "finish") ? retryReceipt ?? pendingAccounts.first?.receipt : nil
        if status != 0 { completion = nil }
        if status == 0, let result = completion, let started = operationStarted {
            completion = (result.summary, "History verified · " + String(format: "%.1f seconds", max(0.1, ProcessInfo.processInfo.systemUptime - started)))
        }
        running = false
        sourceActivity = nil
        badge = status == 0 && !pendingResult ? "100%" : ""
        if status == 0, !demo, !snapshot, moveProgress.hasProgress {
            moveProgress.record(ProcessInfo.processInfo.systemUptime)
            var learned = UserDefaults.standard.dictionary(forKey: MoveProgress.storageKey) as? [String: Double] ?? [:]
            for (key, sample) in moveProgress.observed { learned[key] = (learned[key] ?? sample) * 0.5 + sample * 0.5 }
            UserDefaults.standard.set(learned, forKey: MoveProgress.storageKey)
        }
        if !pendingResult && status == 0 { excluded = []; from = []; to = nil; targetChosen = false; selectionComplete = true }
        symbol = pendingResult ? "clock.arrow.circlepath" : status == 0 ? "checkmark" : "exclamationmark.triangle"
        if status == 0, !pendingResult, !moveProgress.hasProgress, operationArgs.first == "finish" {
            badge = ""
            symbol = lines.isEmpty ? "arrow.left.arrow.right" : "info.circle"
        }
        if status != 0, note.isEmpty { lines.append(("reason", error)); note = "\(operationName) stopped: the operation did not complete."; stopped = true; preserveNotice = true }
        DispatchQueue.main.asyncAfter(deadline: .now() + 4) { [weak self] in
            guard let self, !self.running else { return }
            if !self.restartAvailable || self.symbol != "exclamationmark.triangle" { self.symbol = self.restartAvailable ? "info.circle" : "arrow.left.arrow.right" }
            self.badge = ""
        }
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
        process.arguments = config.arguments(args)
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
    var tag: String? = nil
    let action: () -> Void
    var tagLabels: [String] { radio ? [] : [account.active == true ? "active" : nil, tag].compactMap { $0 } }

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
                        ForEach(tagLabels, id: \.self) { text in Tag(text: text, color: text == "active" ? .green : .orange) }
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
            .fixedSize()
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

struct Pill: View {
    let title: String
    let prominent: Bool
    let enabled: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Text(title)
                .font(.body.weight(.medium))
                .fixedSize()
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

struct CompletionNotice: View {
    let summary: String
    let detail: String
    private let green = Color(red: 0.38, green: 0.84, blue: 0.61)

    var body: some View {
        HStack(spacing: 14) {
            Circle()
                .fill(RadialGradient(colors: [green.opacity(0.08), green.opacity(0.03)], center: .topLeading, startRadius: 0, endRadius: 60))
                .overlay(Circle().strokeBorder(green.opacity(0.4), lineWidth: 1))
                .overlay(Image(systemName: "checkmark").font(.system(size: 20, weight: .medium)).foregroundStyle(Color(red: 0.48, green: 0.87, blue: 0.66)))
                .frame(width: 48, height: 48)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 3) {
                Text(summary).font(.system(size: 15, weight: .medium)).foregroundStyle(Color(red: 0.87, green: 0.91, blue: 0.88))
                    .lineLimit(1).frame(height: 20, alignment: .leading)
                Text(detail).font(.system(size: 13)).foregroundStyle(Color(red: 0.59, green: 0.64, blue: 0.61))
                    .lineLimit(1).frame(height: 17, alignment: .leading)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .offset(y: -1)
        }
        .frame(height: 48)
        .help(summary + "\n" + detail)
        .accessibilityElement(children: .combine)
    }
}

struct Panel: View {
    @EnvironmentObject private var model: Model

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 8) {
                Text("Claude Transplant").font(.system(.title3, design: .rounded, weight: .semibold))
                if let label = model.identityLabel { Text(label).font(.caption).foregroundStyle(.secondary) }
                Spacer()
                Button(action: { model.reset() }) { Image(systemName: "arrow.clockwise") }.buttonStyle(.plain).foregroundStyle(.secondary)
                    .accessibilityLabel("Reset").help("Clear account selections").disabled(model.running || !model.pendingAccounts.isEmpty)
            }
            accountBoard.disabled(!model.canMutate || !model.pendingAccounts.isEmpty)
            if !model.displaySummary.isEmpty { Divider() }
            if model.running {
                Bar(value: model.moveProgress.value)
                Text(model.moveProgress.detail).font(.caption).foregroundStyle(.secondary).monospacedDigit()
            }
            if let completion = model.visibleCompletion {
                CompletionNotice(summary: completion.summary, detail: completion.detail)
                    .padding(.vertical, 2).transition(.opacity)
            } else if !model.displaySummary.isEmpty {
                VStack(alignment: .leading, spacing: 3) {
                    Text(model.statusHeadline.sentence).font(.callout.weight(.medium))
                    if let detail = model.statusDetail { Text(detail).font(.callout).foregroundStyle(.secondary) }
                }.fixedSize(horizontal: false, vertical: true)
            }
            if !model.detailLines.isEmpty {
                DisclosureGroup("Details", isExpanded: $model.detailsExpanded) {
                    if model.detailLines.count <= 3 && model.detailLines.allSatisfy({ !$0.1.contains("\n") && $0.1.count < 240 }) { detailRows }
                    else { ScrollView { detailRows }.frame(height: 200) }
                }.font(.caption)
            }
            if model.restartAvailable && model.pendingAccounts.isEmpty {
                Button(action: { model.restartDesktop() }) { Text("Restart Claude").font(.callout.weight(.medium)).underline() }.buttonStyle(.plain)
                    .disabled(!model.canMutate)
            }
            HStack(spacing: 10) {
                if let title = model.primaryTitle { Pill(title: title, prominent: true, enabled: true) { model.primary() } }
                if model.directActions {
                    if model.canKeepLocal {
                        Pill(title: "Keep moved sessions", prominent: false, enabled: true) { model.stopHere() }
                    }
                    if !model.undoPending {
                        Pill(title: "Undo this move", prominent: false, enabled: model.canMutate) { model.undo() }
                            .help("Attempts to restore the moved sessions. Changed records can prevent Undo.")
                    }
                } else if model.hasSecondaryActions {
                    if model.snapshot { moreActionsLabel }
                    else {
                        Menu {
                            if model.canKeepLocal { Button("Keep moved sessions") { model.stopHere() } }
                            if !model.undoPending { Button("Undo this move") { model.undo() }.disabled(!model.canMutate) }
                        } label: { moreActionsLabel }
                        .menuStyle(.borderlessButton).fixedSize()
                        .accessibilityLabel("More actions")
                        .help("Keep moved sessions or undo this move")
                    }
                }
                Spacer()
                Button("Quit") { NSApplication.shared.terminate(nil) }.buttonStyle(.plain).foregroundStyle(.secondary).fixedSize()
            }
            HStack {
                if model.skipRestartWarning {
                    Button("Show restart warnings", action: model.restoreRestartWarning).buttonStyle(.plain).font(.caption).foregroundStyle(.secondary)
                }
                Spacer()
                if let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String {
                    Text("v\(version)").font(.system(size: 10)).foregroundStyle(.secondary)
                        .accessibilityLabel("Version \(version)")
                }
            }
        }
        .padding(16)
        .frame(width: panelWidth)
        .background(Color(white: 0.11))
        .animation(.easeOut(duration: 0.18), value: model.visibleCompletion?.summary)
        .onAppear { if !model.snapshot { model.panelVisibility(true) } }
        .onDisappear { if !model.snapshot { model.panelVisibility(false) } }
        .onReceive(NotificationCenter.default.publisher(for: NSWindow.didChangeOcclusionStateNotification)) { note in
            if !model.snapshot, let window = note.object as? NSWindow { model.panelVisibility(window.occlusionState.contains(.visible)) }
        }
    }

    private var moreActionsLabel: some View { Image(systemName: "ellipsis.circle") }

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
                    Row(account: account, radio: false, selected: model.from.contains(account.id), muted: !model.canSource(account), tag: model.sourceTag(account)) { model.toggle(account.id) }
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
            let tags = [account.active == true ? "active" : nil, model.sourceTag(account)].compactMap { $0 }.reduce(CGFloat(0)) {
                $0 + ($1 as NSString).size(withAttributes: [.font: NSFont.systemFont(ofSize: 10, weight: .semibold)]).width + 18
            }
            return max((account.name as NSString).size(withAttributes: name).width, (account.plan as NSString).size(withAttributes: plan).width + tags)
        }.max() ?? 0
        return min(300, max(180, 44 + ceil(widest)))
    }

    static let gap: CGFloat = 150
    static let visibleRows = 10

    private var panelWidth: CGFloat {
        let summary = model.visibleCompletion?.summary ?? ""
        let text = (summary as NSString).size(withAttributes: [.font: NSFont.systemFont(ofSize: 15, weight: .medium)]).width
        let titles = ([model.primaryTitle] + (model.directActions ? [model.canKeepLocal ? "Keep moved sessions" : nil, model.undoPending ? nil : "Undo this move"] : [])).compactMap { $0 }
        let controls = titles.reduce(CGFloat(0)) { $0 + ceil(($1 as NSString).size(withAttributes: [.font: NSFont.systemFont(ofSize: NSFont.systemFontSize, weight: .medium)]).width) + 42 }
        return max(2 * columnWidth + Panel.gap + 32, ceil(text) + 96, controls + 100)
    }

    private var detailRows: some View {
        VStack(alignment: .leading, spacing: 8) {
            ForEach(Array(model.detailLines.enumerated()), id: \.offset) { item in
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Text(item.element.0).foregroundStyle(.secondary).frame(width: 60, alignment: .leading)
                    Text(item.element.1).fixedSize(horizontal: false, vertical: true)
                }
            }
        }.font(.system(.caption, design: .monospaced)).frame(maxWidth: .infinity, alignment: .leading)
    }

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

    @MainActor
    static func dialogData(_ plan: Event) -> Data? {
        let alert = RestartPrompt(plan: plan).alert()
        alert.window.appearance = NSAppearance(named: .aqua)
        alert.layout()
        guard let view = alert.window.contentView else { return nil }
        view.layoutSubtreeIfNeeded()
        guard let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: Int(view.bounds.width * 2), pixelsHigh: Int(view.bounds.height * 2), bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0), let context = NSGraphicsContext(bitmapImageRep: bitmap) else { return nil }
        bitmap.size = view.bounds.size
        alert.window.effectiveAppearance.performAsCurrentDrawingAppearance {
            NSGraphicsContext.saveGraphicsState()
            NSGraphicsContext.current = context
            context.cgContext.scaleBy(x: 2, y: 2)
            NSColor.windowBackgroundColor.setFill()
            NSBezierPath(rect: view.bounds).fill()
            view.displayIgnoringOpacity(view.bounds, in: context)
            NSGraphicsContext.restoreGraphicsState()
        }
        return bitmap.representation(using: .png, properties: [:])
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
        model.lines = [("inventory", "318 records | 3 already there | 307 to move"), ("move", "307 ✓ | 307 zero-copy"), ("verify", "chat messages unchanged ✓ | sidecars unchanged ✓ | desktop ✓")]
        model.note = "307 sessions moved"
        model.completion = (model.note, "History verified · 8.1 seconds")
        let size = ImageRenderer(content: Panel().environmentObject(model).environment(\.colorScheme, .dark)).nsImage?.size
        model.lines = []
        model.note = ""
        model.completion = nil
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
        model.moveProgress = MoveProgress(now: 0)
        model.moveProgress.update("scan", completed: 0, total: 318, now: 0)
        model.lines = [("inventory", "318 records | 3 already there | 307 to move")]
        snap(300)
        model.moveProgress.update("scan", completed: 318, total: 318, now: 2)
        model.progressLabel = "Moving sessions"
        for (index, completed) in [75, 170, 250, 307].enumerated() {
            model.moveProgress.update("move", completed: completed, total: 307, now: 3 + Double(index))
            snap(180)
        }
        model.running = false
        model.badge = ""
        model.lines.append(("move", "307 ✓ | 307 zero-copy"))
        model.lines.append(("verify", "chat messages unchanged ✓ | sidecars unchanged ✓ | desktop ✓"))
        model.symbol = "checkmark"
        model.handle("{\"done\":true,\"ok\":true,\"complete\":true,\"moved\":307,\"failed\":[],\"waiting\":[]}")
        model.completion = (model.note, "History verified · 8.1 seconds")
        snap(2400)
        try? JSONSerialization.data(withJSONObject: durations).write(to: root.appendingPathComponent("durations.json"))
        exit(0)
    }
}

struct MenuLabel: View {
    let symbol: String
    let badge: String

    var image: NSImage {
        let size = NSImage(systemSymbolName: "arrow.left.arrow.right", accessibilityDescription: nil)!.size
        let image = NSImage(size: size, flipped: false) { rect in
            if badge.isEmpty {
                let glyph = NSImage(systemSymbolName: symbol, accessibilityDescription: nil)!
                let scale = min(rect.width / glyph.size.width, rect.height / glyph.size.height)
                let width = glyph.size.width * scale, height = glyph.size.height * scale
                glyph.draw(in: NSRect(x: (rect.width - width) / 2, y: (rect.height - height) / 2, width: width, height: height))
            } else {
                let font = NSFont.monospacedSystemFont(ofSize: 10, weight: .semibold)
                let text = NSAttributedString(string: badge, attributes: [.font: font, .foregroundColor: NSColor.black])
                let measured = text.size()
                let scale = min(1, (rect.width - 1) / measured.width)
                guard let context = NSGraphicsContext.current?.cgContext else { return false }
                context.saveGState()
                context.translateBy(x: (rect.width - measured.width * scale) / 2, y: (rect.height - measured.height) / 2)
                context.scaleBy(x: scale, y: 1)
                text.draw(at: .zero)
                context.restoreGState()
            }
            return true
        }
        image.isTemplate = true
        return image
    }

    var body: some View {
        Image(nsImage: image)
            .accessibilityLabel(badge.isEmpty ? "Claude Transplant" : badge + " complete")
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
            MenuLabel(symbol: model.recoveryProblem == nil ? model.symbol : "exclamationmark.triangle", badge: model.recoveryProblem == nil ? model.badge : "")
                .help(model.running ? "Estimated completion" : "Claude Transplant")
        }
        .menuBarExtraStyle(.window)
    }
}
