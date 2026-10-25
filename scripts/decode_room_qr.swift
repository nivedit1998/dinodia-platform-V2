// Synthetic test artifacts only. Emits a digest, never the decoded room reference.
import Foundation
import Vision
import CryptoKit
let request = VNDetectBarcodesRequest()
request.symbologies = [.qr]
try VNImageRequestHandler(url: URL(fileURLWithPath: CommandLine.arguments[1])).perform([request])
guard let value = request.results?.first?.payloadStringValue else { fatalError("Synthetic QR did not decode") }
print(SHA256.hash(data: Data(value.utf8)).map { String(format: "%02x", $0) }.joined())
