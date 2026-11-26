import SwiftUI

struct ContentView: View {
    @Binding var statusText: String

    var body: some View {
        VStack(spacing: 16) {
            Text("Main Desktop App")
                .font(.largeTitle)
                .bold()

            Text("Current Status: \(statusText)")
                .foregroundStyle(.secondary)

            TextField("Update status...", text: $statusText)
                .textFieldStyle(.roundedBorder)
                .frame(width: 250)
        }
        .padding(30)
        .frame(minWidth: 400, minHeight: 300)
    }
}
