import SwiftUI
import UserNotifications

struct Account: Decodable, Identifiable {
    let account: String
    let org: String
    let label: String
    let stats: String
    let active: Bool?
    var id: String { account + "/" + org }
    var selector: String { account + " " + org }
    var detail: String { stats.replacingOccurrences(of: " | active", with: "").replacingOccurrences(of: " | ", with: "  ·  ") }
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
    let ok: Bool?
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
    let demo: Bool
    private let config: Config?

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

    var ready: Bool { !running && !from.isEmpty && to != nil && (config != nil || demo) }
    var remaining: [Account] { accounts.filter { !from.contains($0.id) } }
    var sources: [Account] { remaining.count == 1 && !from.isEmpty ? accounts.filter { $0.id != remaining[0].id } : accounts }
    var progress: Double? {
        let parts = badge.split(separator: "/")
        guard parts.count == 2, let done = Double(parts[0]), let total = Double(parts[1]), total > 0 else { return nil }
        return done / total
    }

    func toggle(_ id: String) {
        if from.contains(id) { from.remove(id) } else { from.insert(id) }
        if to == id { to = nil }
        if remaining.count == 1 { to = remaining[0].id }
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

    func begin() {
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
            let failed = event.failed ?? []
            if !failed.isEmpty {
                lines.append(("failed", failed.map { ($0.title ?? "?") + " | " + $0.error }.joined(separator: "\n")))
            }
            let summary = moved == 0 ? (failed.isEmpty ? "Nothing to move" : "\(failed.count) failed") : "\(moved) sessions moved" + (failed.isEmpty ? "" : ", \(failed.count) failed")
            note = event.note ?? summary
            notify(summary, event.note ?? "")
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

    private func run(_ args: [String], line: @escaping (String) -> Void, done: @escaping (Int32) -> Void) {
        guard let config else { done(1); return }
        let process = Process()
        process.executableURL = URL(fileURLWithPath: node(config.node))
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
                Text(account.label).lineLimit(1).truncationMode(.tail)
                if account.active == true {
                    Text("active")
                        .font(.system(size: 10, weight: .semibold))
                        .padding(.horizontal, 6)
                        .padding(.vertical, 2)
                        .background(Color.green.opacity(0.18), in: Capsule())
                        .foregroundStyle(.green)
                }
                Spacer(minLength: 12)
                Text(account.detail).font(.system(.caption, design: .rounded)).monospacedDigit().foregroundStyle(.secondary).fixedSize()
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
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
            block("From") {
                ForEach(model.sources) { account in
                    Row(account: account, on: model.from.contains(account.id), radio: false) { model.toggle(account.id) }
                }
            }
            block("To") {
                ForEach(model.remaining) { account in
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
            if let progress = model.progress { Bar(value: progress) }
            if !model.note.isEmpty { Text(model.note.sentence).font(.callout.weight(.medium)) }
            HStack(spacing: 10) {
                Pill(title: "Move", prominent: true, enabled: model.ready) { model.move() }
                Pill(title: "Undo last", prominent: false, enabled: !model.running) { model.undo() }
                Spacer()
                Button("Quit") { NSApplication.shared.terminate(nil) }.buttonStyle(.plain).foregroundStyle(.secondary)
            }
        }
        .padding(18)
        .frame(width: 520)
    }

    private func block<Content: View>(_ title: String, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title.uppercased()).font(.caption2.weight(.semibold)).tracking(0.8).foregroundStyle(.secondary)
            content()
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
            LinearGradient(colors: [Color(red: 0.13, green: 0.17, blue: 0.38), Color(red: 0.42, green: 0.16, blue: 0.36), Color(red: 0.86, green: 0.42, blue: 0.30)], startPoint: .topLeading, endPoint: .bottomTrailing)
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
        .frame(width: 760, height: 500, alignment: .topLeading)
        .environment(\.colorScheme, .dark)
    }
}

enum Demo {
    static let accounts = [
        Account(account: "john", org: "personal", label: "john@example.com · Personal", stats: "86 | 2h ago | api", active: false),
        Account(account: "john", org: "team", label: "john@example.com · Team", stats: "212 | 3d ago | api", active: false),
        Account(account: "john2", org: "personal", label: "john2@example.com · Personal", stats: "35 | 5d ago | notes", active: false),
        Account(account: "john2", org: "team", label: "john2@example.com · Team", stats: "12 | 4m ago | notes", active: true)
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
        for (index, y) in [108.0, 130.0, 152.0].enumerated() {
            glide(to: CGPoint(x: 292, y: y), frames: 7)
            model.toggle(accounts[index].id)
            snap(index == 2 ? 1000 : 450)
        }
        glide(to: CGPoint(x: 282, y: 238), frames: 8)
        model.begin()
        model.lines = [("inventory", "333 records | 4 without history | 21 same lineage twice | 3 already there | 305 to move")]
        snap(250)
        glide(to: CGPoint(x: 150, y: 420), frames: 6)
        for done in stride(from: 0, through: 305, by: 23) {
            model.badge = "\(done)/305"
            snap(100)
        }
        model.badge = "305/305"
        snap(150)
        model.badge = ""
        model.lines.append(("fork", "305 ✓ | 141,228 events | 9 replay duplicates collapsed"))
        snap(350)
        model.lines.append(("sidecars", "1,842 files | sha256 ✓"))
        snap(350)
        model.lines.append(("desktop", "305 records | 240 archived | 65 active"))
        snap(350)
        model.lines.append(("verify", "provenance ✓ | lineage ✓ | sidecars ✓ | sources unchanged ✓ | 38s"))
        snap(500)
        model.running = false
        model.symbol = "checkmark"
        model.note = "restart Claude Code to see them"
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
