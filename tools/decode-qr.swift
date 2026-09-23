// Decodes QR images with Vision so the encoder can be checked against a real
// decoder rather than against itself. Usage: swift decode-qr.swift a.png b.png
import Foundation
import Vision
import CoreImage

for path in CommandLine.arguments.dropFirst() {
    guard let image = CIImage(contentsOf: URL(fileURLWithPath: path)) else {
        print("ERROR\tcannot read \(path)")
        continue
    }
    let request = VNDetectBarcodesRequest()
    request.symbologies = [.qr]
    let handler = VNImageRequestHandler(ciImage: image, options: [:])
    do {
        try handler.perform([request])
        let results = request.results ?? []
        guard let payload = results.first?.payloadStringValue else {
            print("ERROR\tno QR found in \(path)")
            continue
        }
        print("OK\t\(payload)")
    } catch {
        print("ERROR\t\(error.localizedDescription)")
    }
}
