// TLS fingerprint pinning verifier (rustls 0.23).
// The verifier REQUIRES the presented leaf certificate's SHA-256 to equal the
// pinned fingerprint obtained during QR pairing. It also checks the certificate
// validity window. This is deliberately NOT "danger_accept_invalid_certs".

use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::crypto::{verify_tls12_signature, verify_tls13_signature};
use rustls::pki_types::{CertificateDer, ServerName, UnixTime};
use rustls::{DigitallySignedStruct, Error, SignatureScheme};
use sha2::{Digest, Sha256};

#[derive(Debug, Clone)]
pub struct PinVerifier {
    pub pinned_fingerprint: [u8; 32],
    pub provider: std::sync::Arc<rustls::crypto::CryptoProvider>,
}

impl PinVerifier {
    pub fn new(pinned_fingerprint: [u8; 32]) -> Self {
        // ring provider: pure-Rust crypto, cross-compiles cleanly to Android
        // (aws-lc-rs would need CMake/NASM/Go NDK toolchains).
        let provider = rustls::crypto::ring::default_provider();
        Self { pinned_fingerprint, provider: std::sync::Arc::new(provider) }
    }

    pub fn fingerprint_bytes(der: &[u8]) -> [u8; 32] {
        let mut h = Sha256::new();
        h.update(der);
        h.finalize().into()
    }

    pub fn hex_to_bytes(hex: &str) -> Option<[u8; 32]> {
        let hex = hex.trim().to_lowercase();
        if hex.len() != 64 {
            return None;
        }
        let mut out = [0u8; 32];
        for i in 0..32 {
            out[i] = u8::from_str_radix(&hex[i * 2..i * 2 + 2], 16).ok()?;
        }
        Some(out)
    }
}

impl ServerCertVerifier for PinVerifier {
    fn verify_server_cert(
        &self,
        end_entity: &CertificateDer<'_>,
        _intermediates: &[CertificateDer<'_>],
        _server_name: &ServerName<'_>,
        _ocsp_response: &[u8],
        now: UnixTime,
    ) -> Result<ServerCertVerified, Error> {
        let actual = Self::fingerprint_bytes(end_entity.as_ref());
        if actual != self.pinned_fingerprint {
            return Err(Error::General(format!(
                "certificate pin mismatch: expected {:02x}{:02x}.. got {:02x}{:02x}..",
                self.pinned_fingerprint[0], self.pinned_fingerprint[1],
                actual[0], actual[1]
            )));
        }
        // Validity window check (parse DER with x509-parser)
        let (_, cert) = x509_parser::parse_x509_certificate(end_entity.as_ref())
            .map_err(|e| Error::General(format!("cert parse failed: {e}")))?;
        let valid = cert.validity();
        let now_secs = now.as_secs() as i64;
        if valid.not_after.timestamp() < now_secs || valid.not_before.timestamp() > now_secs {
            return Err(Error::General("certificate not currently valid".into()));
        }
        Ok(ServerCertVerified::assertion())
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, Error> {
        verify_tls12_signature(
            message,
            cert,
            dss,
            &self.provider.signature_verification_algorithms,
        )
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, Error> {
        verify_tls13_signature(
            message,
            cert,
            dss,
            &self.provider.signature_verification_algorithms,
        )
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.provider.signature_verification_algorithms.supported_schemes()
    }
}

pub fn build_pinned_client_config(fp_hex: &str) -> Result<rustls::ClientConfig, String> {
    let fp = PinVerifier::hex_to_bytes(fp_hex).ok_or("invalid fingerprint (need 64 hex chars)")?;
    let verifier = std::sync::Arc::new(PinVerifier::new(fp));
    let config = rustls::ClientConfig::builder()
        .dangerous()
        .with_custom_certificate_verifier(verifier)
        .with_no_client_auth();
    Ok(config)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    fn fixture_der() -> Vec<u8> {
        // Synthetic test-only certificate. The ephemeral key is never serialized,
        // persisted, or used for a network connection.
        let key = rcgen::KeyPair::generate().expect("ephemeral test key");
        let mut params = rcgen::CertificateParams::new(vec!["localhost".to_string()])
            .expect("test certificate parameters");
        params.not_before = rcgen::date_time_ymd(2026, 1, 1);
        params.not_after = rcgen::date_time_ymd(2028, 1, 1);
        params.self_signed(&key).expect("synthetic test certificate").der().to_vec()
    }

    fn cert<'a>(der: &'a [u8]) -> rustls::pki_types::CertificateDer<'a> {
        rustls::pki_types::CertificateDer::from(der.to_vec())
    }

    #[test]
    fn correct_pin_accepts() {
        let der = fixture_der();
        let fp = PinVerifier::fingerprint_bytes(&der);
        let v = PinVerifier::new(fp);
        let now = rustls::pki_types::UnixTime::now();
        let r = v.verify_server_cert(&cert(&der), &[], &rustls::pki_types::ServerName::try_from("localhost").unwrap(), &[], now);
        assert!(r.is_ok(), "correct pin must pass: {r:?}");
    }

    #[test]
    fn wrong_pin_rejects() {
        let der = fixture_der();
        let wrong = [0u8; 32];
        let v = PinVerifier::new(wrong);
        let now = rustls::pki_types::UnixTime::now();
        let r = v.verify_server_cert(&cert(&der), &[], &rustls::pki_types::ServerName::try_from("localhost").unwrap(), &[], now);
        assert!(r.is_err(), "wrong pin must fail");
        assert!(format!("{r:?}").contains("pin mismatch"), "error mentions pin mismatch");
    }

    #[test]
    fn expired_cert_rejects() {
        // The test cert is valid ~2026-2028. Asking to verify it "now" in the far
        // future (2040) makes it expired -> must fail.
        let der = fixture_der();
        let fp = PinVerifier::fingerprint_bytes(&der);
        let v = PinVerifier::new(fp);
        let far_future = rustls::pki_types::UnixTime::since_unix_epoch(Duration::from_secs(2208988800)); // 2040-01-01
        let r = v.verify_server_cert(&cert(&der), &[], &rustls::pki_types::ServerName::try_from("localhost").unwrap(), &[], far_future);
        assert!(r.is_err(), "expired cert must fail");
        assert!(format!("{r:?}").contains("not currently valid"), "error mentions validity");
    }

    #[test]
    fn hex_roundtrip() {
        let der = fixture_der();
        let fp = PinVerifier::fingerprint_bytes(&der);
        let hex = fp.iter().map(|b| format!("{b:02x}")).collect::<String>();
        assert_eq!(PinVerifier::hex_to_bytes(&hex).unwrap(), fp);
    }
}
