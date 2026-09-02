import SwiftUI
import UserNotifications

struct Account: Decodable, Identifiable {
    let account: String
    let org: String
    let label: String
    let stats: String
    var id: String { account + "/" + org }
    var selector: String { account + " " + org }
    var detail: String { stats.replacingOccurrences(of: " | ", with: "  ·  ") }
}

struct Config: Decodable {
    let node: String
    let script: String
}

struct Failure: Decodable {
    let title: String?
    let error: String
}

struct Event: Decodable {
    let stage: String?
    let text: String?
    let live: Bool?
    let done: Bool?
    let moved: Int?
    let failed: [Failure]?
    let note: String?
    let undone: String?
    let sessions: Int?
    let refused: [String]?
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
    private let config: Config?

    init() {
        let file = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support/claude-transplant/menubar.json")
        config = (try? Data(contentsOf: file)).flatMap { try? JSONDecoder().decode(Config.self, from: $0) }
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound]) { _, _ in }
        refresh()
    }

    var ready: Bool { !running && !from.isEmpty && to != nil && config != nil }
    var targets: [Account] { accounts.filter { !from.contains($0.id) } }

    func toggle(_ id: String) {
        if from.contains(id) { from.remove(id) } else { from.insert(id) }
        if to == id { to = nil }
    }

    func refresh() {
        var text = ""
        run(["accounts", "--json"], line: { text += $0 }) { [weak self] _ in
            guard let self, let data = text.data(using: .utf8), let list = try? JSONDecoder().decode([Account].self, from: data) else { return }
            accounts = list
            from = from.filter { id in list.contains { $0.id == id } }
            if let current = to, !list.contains(where: { $0.id == current }) { to = nil }
        }
    }

    func move() {
        guard ready, let target = accounts.first(where: { $0.id == to }) else { return }
        let args = accounts.filter { from.contains($0.id) }.flatMap { ["--from", $0.selector] } + ["--to", target.selector, "--json"]
        begin()
        run(args, line: { [weak self] in self?.handle($0) }) { [weak self] in self?.finish($0) }
    }

    func undo() {
        guard !running else { return }
        begin()
        run(["undo", "--json"], line: { [weak self] in self?.handle($0) }) { [weak self] in self?.finish($0) }
    }

    private func begin() {
        lines = []
        note = ""
        running = true
        symbol = "arrow.triangle.2.circlepath"
    }

    private func handle(_ line: String) {
        guard let data = line.data(using: .utf8), let event = try? JSONDecoder().decode(Event.self, from: data) else { return }
        if let stage = event.stage, let text = event.text {
            if event.live == true {
                badge = text
            } else {
                lines.removeAll { $0.0 == stage }
                lines.append((stage, text))
            }
        } else if event.done == true {
            let moved = event.moved ?? 0
            if let failed = event.failed, !failed.isEmpty {
                lines.append(("failed", failed.map { ($0.title ?? "?") + " | " + $0.error }.joined(separator: "\n")))
            }
            note = event.note ?? (moved == 0 ? "Nothing to move" : "")
            notify(moved == 0 ? "Nothing to move" : "\(moved) sessions moved", event.note ?? "")
        } else if event.undone != nil {
            note = event.note ?? ""
            notify("\(event.sessions ?? 0) sessions undone", note)
        } else if let refused = event.refused {
            note = "Undo refused, \(refused.count) sessions gained messages"
            lines = refused.map { ("kept", $0) }
        } else if event.nothing == true {
            note = "Nothing to undo"
        }
    }

    private func finish(_ status: Int32) {
        running = false
        badge = ""
        symbol = status == 0 ? "checkmark" : "exclamationmark.triangle"
        if status != 0, note.isEmpty { note = "Failed, run npx claude-transplant in a terminal" }
        DispatchQueue.main.asyncAfter(deadline: .now() + 4) { [weak self] in self?.symbol = "arrow.left.arrow.right" }
        refresh()
    }

    private func notify(_ title: String, _ body: String) {
        let content = UNMutableNotificationContent()
        content.title = title
        content.body = body.sentence
        UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: UUID().uuidString, content: content, trigger: nil))
    }

    private func run(_ args: [String], line: @escaping (String) -> Void, done: @escaping (Int32) -> Void) {
        guard let config else { done(1); return }
        let process = Process()
        process.executableURL = URL(fileURLWithPath: config.node)
        process.arguments = [config.script] + args
        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = FileHandle.nullDevice
        do { try process.run() } catch { done(1); return }
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
            let status = process.terminationStatus
            DispatchQueue.main.async { done(status) }
        }
    }
}

struct Row: View {
    let account: Account
    let on: Bool
    let radio: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 8) {
                Image(systemName: on ? (radio ? "largecircle.fill.circle" : "checkmark.circle.fill") : "circle")
                    .foregroundStyle(on ? AnyShapeStyle(Color.accentColor) : AnyShapeStyle(.tertiary))
                Text(account.label).lineLimit(1)
                Spacer(minLength: 12)
                Text(account.detail).font(.system(.caption, design: .rounded)).monospacedDigit().foregroundStyle(.secondary)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
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
            block("From") {
                ForEach(model.accounts) { account in
                    Row(account: account, on: model.from.contains(account.id), radio: false) { model.toggle(account.id) }
                }
            }
            block("To") {
                ForEach(model.targets) { account in
                    Row(account: account, on: model.to == account.id, radio: true) { model.to = account.id }
                }
            }
            if !model.lines.isEmpty || !model.note.isEmpty { Divider() }
            ForEach(model.lines, id: \.0) { item in
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Text(item.0).foregroundStyle(.secondary).frame(width: 60, alignment: .leading)
                    Text(item.1)
                }
                .font(.system(.caption, design: .monospaced))
            }
            if !model.note.isEmpty { Text(model.note.sentence).font(.callout.weight(.medium)) }
            HStack(spacing: 10) {
                Button("Move") { model.move() }.keyboardShortcut(.defaultAction).disabled(!model.ready)
                Button("Undo last") { model.undo() }.disabled(model.running)
                Spacer()
                Button("Quit") { NSApplication.shared.terminate(nil) }.buttonStyle(.plain).foregroundStyle(.secondary)
            }
        }
        .padding(16)
        .frame(width: 420)
    }

    private func block<Content: View>(_ title: String, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title.uppercased()).font(.caption2.weight(.semibold)).tracking(0.8).foregroundStyle(.secondary)
            content()
        }
    }
}

@main
struct TransplantApp: App {
    @StateObject private var model = Model()

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
