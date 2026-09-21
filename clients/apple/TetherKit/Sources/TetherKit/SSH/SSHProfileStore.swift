import Foundation

final class SSHProfileStore {
  private let storage: SSHKeyValueStore
  private let key = "tether.ssh.profiles"

  init(storage: SSHKeyValueStore) {
    self.storage = storage
  }

  func list() -> [SSHHostProfile] {
    guard let data = storage.data(forKey: key),
          let profiles = try? JSONDecoder().decode([SSHHostProfile].self, from: data)
    else { return [] }
    return profiles
  }

  func add(_ profile: SSHHostProfile) {
    var profiles = list()
    if let index = profiles.firstIndex(where: { $0.id == profile.id }) {
      profiles[index] = profile
    } else {
      profiles.append(profile)
    }
    persist(profiles)
  }

  func remove(id: String) {
    persist(list().filter { $0.id != id })
  }

  private func persist(_ profiles: [SSHHostProfile]) {
    storage.set(try? JSONEncoder().encode(profiles), forKey: key)
  }
}
