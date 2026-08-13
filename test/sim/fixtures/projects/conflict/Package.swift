// swift-tools-version: 5.9
import PackageDescription

let package = Package(
  name: "Legacy",
  platforms: [.iOS(.v17)],
  dependencies: [
    .package(url: "https://github.com/EmergeTools/SnapshotPreviews", exact: "0.9.4"),
  ],
  targets: [.target(name: "Legacy")]
)
