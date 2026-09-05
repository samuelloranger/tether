import Foundation

enum AuthorizedHTTP {
  /// A 401 triggers exactly one silent re-mint (invalidate the cached token,
  /// mint a fresh one) and retry; a second 401 surfaces to the caller.
  static func sendAuthorizedOnce(
    bearer: @escaping () async throws -> String,
    invalidate: @escaping () async -> Void,
    makeRequest: @escaping (_ bearer: String) async throws -> URLRequest,
    data: @escaping (URLRequest) async throws -> (Data, Int)
  ) async throws -> (Data, Int) {
    let token = try await bearer()
    let (responseData, status) = try await data(try await makeRequest(token))
    guard status == 401 else {
      return (responseData, status)
    }
    await invalidate()
    let retryToken = try await bearer()
    return try await data(try await makeRequest(retryToken))
  }

  static func sendAuthorizedOnce(
    bearer: @escaping () async throws -> String,
    invalidate: @escaping () async -> Void,
    url: URL,
    method: String = "GET",
    body: Data? = nil,
    data: @escaping (URLRequest) async throws -> (Data, Int)
  ) async throws -> (Data, Int) {
    try await sendAuthorizedOnce(
      bearer: bearer,
      invalidate: invalidate,
      makeRequest: { token in
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if let body {
          request.httpBody = body
          request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        return request
      },
      data: data
    )
  }
}
