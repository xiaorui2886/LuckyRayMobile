package com.luckyray.mobile

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.AtomicFile
import android.util.Base64
import java.io.FileOutputStream
import java.security.KeyStore
import java.security.MessageDigest
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * Android Keystore-backed AES-256-GCM secure credential store.
 * Equivalent secure storage verified in M1 (Stronghold cannot cross-compile
 * from Windows: libsodium configure needs a POSIX shell).
 *
 * Credential ciphertext is app-private; the AES key remains in Android
 * Keystore. Revoke/reset delete every ciphertext atomically and report a
 * failure rather than claiming that secure state was cleared when it was not.
 */
object KeystoreBridge {
    private const val KS = "AndroidKeyStore"
    private const val ALIAS = "luckyray_mobile_credential"
    private const val FILE_PREFIX = "m1_keystore_store_"
    private const val LEGACY_FILE = "m1_keystore_store.bin"

    lateinit var appContext: Context

    init { nativeInit() }

    private external fun nativeInit()

    @JvmStatic
    fun saveSecret(key: String, value: String): String {
        val file = fileName(key)
        if (value.isEmpty()) {
            deleteFileIfPresent(file)
            // M2.4 originally used one unkeyed file. Clearing a credential must
            // also remove that compatibility artifact so reset/revoke leaves no
            // usable orphan behind.
            deleteFileIfPresent(LEGACY_FILE)
            deleteFileIfPresent("$LEGACY_FILE.bak")
            deleteFileIfPresent("$LEGACY_FILE.new")
            return "ok"
        }

        writeFileAtomically(file, encrypt(value))
        // A successful keyed write upgrades any prior one-slot store. This is
        // deliberately after the durable keyed write, so an interruption can
        // still recover through the legacy read path rather than lose the sole
        // credential.
        deleteFileIfPresent(LEGACY_FILE)
        deleteFileIfPresent("$LEGACY_FILE.bak")
        deleteFileIfPresent("$LEGACY_FILE.new")
        return "ok"
    }

    @JvmStatic
    fun loadSecret(key: String): String {
        val scoped = fileName(key)
        // Do not fall back to a legacy credential when a scoped ciphertext is
        // present but corrupt/unreadable: that could associate a stale secret
        // with the wrong instance after a partial lifecycle operation.
        return if (appContext.getFileStreamPath(scoped).exists()) {
            loadFile(scoped) ?: ""
        } else {
            loadFile(LEGACY_FILE) ?: ""
        }
    }

    @JvmStatic
    fun deleteAllSecrets(): String {
        appContext.filesDir.listFiles()
            ?.filter {
                    it.name.startsWith(FILE_PREFIX) ||
                    it.name == LEGACY_FILE ||
                    it.name == "$LEGACY_FILE.bak" ||
                    it.name == "$LEGACY_FILE.new"
            }
            ?.forEach { file ->
                if (file.exists() && !file.delete()) {
                    throw IllegalStateException("unable to delete secure credential ciphertext")
                }
            }
        return "ok"
    }

    private fun fileName(key: String): String {
        val digest = MessageDigest.getInstance("SHA-256").digest(key.toByteArray(Charsets.UTF_8))
        val encoded = Base64.encodeToString(digest, Base64.NO_WRAP or Base64.URL_SAFE)
        return "$FILE_PREFIX$encoded.bin"
    }

    private fun deleteFileIfPresent(file: String) {
        val target = appContext.getFileStreamPath(file)
        if (target.exists() && !appContext.deleteFile(file)) {
            throw IllegalStateException("unable to delete secure credential ciphertext")
        }
    }

    private fun writeFileAtomically(file: String, data: ByteArray) {
        val atomic = AtomicFile(appContext.getFileStreamPath(file))
        val stream: FileOutputStream = atomic.startWrite()
        try {
            stream.write(data)
            stream.fd.sync()
            atomic.finishWrite(stream)
        } catch (error: Exception) {
            atomic.failWrite(stream)
            throw error
        }
    }

    private fun loadFile(file: String): String? {
        return try {
            val data = appContext.openFileInput(file).use { it.readBytes() }
            decrypt(data)
        } catch (_: Exception) {
            null
        }
    }

    private fun getOrCreateKey(): SecretKey {
        val ks = KeyStore.getInstance(KS).apply { load(null) }
        (ks.getKey(ALIAS, null) as? SecretKey)?.let { return it }
        val kg = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, KS)
        kg.init(
            KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .build()
        )
        return kg.generateKey()
    }

    private fun encrypt(plain: String): ByteArray {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, getOrCreateKey())
        val ciphertext = cipher.doFinal(plain.toByteArray(Charsets.UTF_8))
        return cipher.iv + ciphertext
    }

    private fun decrypt(data: ByteArray): String? {
        if (data.size < 13) return null
        val iv = data.copyOfRange(0, 12)
        val ciphertext = data.copyOfRange(12, data.size)
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, getOrCreateKey(), GCMParameterSpec(128, iv))
        return String(cipher.doFinal(ciphertext), Charsets.UTF_8)
    }
}
