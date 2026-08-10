import LocalAuthentication
import Foundation

let context = LAContext()
var error: NSError?

let reason = "Güvenli dosya erişimi için kimliğinizi doğrulayın."

if context.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: &error) {
    let semaphore = DispatchSemaphore(value: 0)
    var success = false
    
    context.evaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, localizedReason: reason) { (authSuccess, authError) in
        success = authSuccess
        if let err = authError {
            fputs("Error: \(err.localizedDescription)\n", stderr)
        }
        semaphore.signal()
    }
    
    _ = semaphore.wait(timeout: .distantFuture)
    if success {
        exit(0)
    } else {
        exit(1)
    }
} else {
    if context.canEvaluatePolicy(.deviceOwnerAuthentication, error: &error) {
        let semaphore = DispatchSemaphore(value: 0)
        var success = false
        
        context.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: reason) { (authSuccess, authError) in
            success = authSuccess
            if let err = authError {
                fputs("Error: \(err.localizedDescription)\n", stderr)
            }
            semaphore.signal()
        }
        
        _ = semaphore.wait(timeout: .distantFuture)
        if success {
            exit(0)
        } else {
            exit(2)
        }
    } else {
        fputs("Error: Biometrics and Passcode authentication not available\n", stderr)
        exit(3)
    }
}
