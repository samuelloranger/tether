import Foundation

/// HTTP helpers for `/api/push/*`. Lives in its own file so neighbouring agents
/// can keep editing `NativeHostClient.swift`; request construction mirrors that
/// type's private helpers (Bearer + JSON) using the public profile + Keychain.
extension NativeHostClient {
  /// POST `/api/push/register` — body shape from `apps/server/src/server/app.ts`:
  /// `{ deviceToken: 64-hex, secretKey: base64(32 bytes), label?: string≤100 }`.
  public func registerPushDevice(
    deviceToken: String,
    secretKey: String,
    label: String? = nil
  ) async throws {
    var payload: [String: Any] = [
      "deviceToken": deviceToken,
      "secretKey": secretKey,
    ]
    if let label, !label.isEmpty {
      payload["label"] = String(label.prefix(100))
    }
    let body = try JSONSerialization.data(withJSONObject: payload)
    try await pushRequest(path: "/api/push/register", body: body)
  }

  /// POST `/api/push/unregister` — `{ deviceToken: string }`.
  public func unregisterPushDevice(deviceToken: String) async throws {
    let body = try JSONSerialization.data(withJSONObject: ["deviceToken": deviceToken])
    try await pushRequest(path: "/api/push/unregister", body: body)
  }

  private func pushRequest(path: String, body: Data) async throws {
    guard let base = profile.baseHTTPURL else { throw HostClientError.invalidURL }
    let url = base.appendingPathComponent(
      path.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
    )
    var request = URLRequest(url: url)
    request.httpMethod = "POST"
    request.httpBody = body
    request.setValue("Bearer \(try await bearerValue())", forHTTPHeaderField: "Authorization")
    request.setValue("application/json", forHTTPHeaderField: "Accept")
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    let (_, response) = try await URLSession.shared.data(for: request)
    let status = (response as? HTTPURLResponse)?.statusCode ?? 0
    guard status != 401 else { throw HostClientError.unauthorized }
    guard (200..<300).contains(status) else { throw HostClientError.httpStatus(status) }
  }
}
