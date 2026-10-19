import java.io.File
import javax.inject.Inject
import org.gradle.api.DefaultTask
import org.gradle.api.GradleException
import org.gradle.api.logging.LogLevel
import org.gradle.api.tasks.Input
import org.gradle.api.tasks.TaskAction
import org.gradle.process.ExecOperations

// Maintained with the other generated Android sources. Invoke the installed
// CLI directly: npm dispatch and executable-suffix retries can hide the real
// build failure or select a different checkout on Windows.
abstract class BuildTask @Inject constructor(
    private val execOperations: ExecOperations,
) : DefaultTask() {
    @get:Input var rootDirRel: String? = null
    @get:Input var target: String? = null
    @get:Input var release: Boolean? = null

    @TaskAction
    fun assemble() {
        val rustRoot = rootDirRel ?: throw GradleException("rootDirRel cannot be null")
        val rustTarget = target ?: throw GradleException("target cannot be null")
        val isRelease = release ?: throw GradleException("release cannot be null")
        val repoRoot = File(project.rootDir, "../../..").canonicalFile
        val cli = File(repoRoot, "node_modules/@tauri-apps/cli/tauri.js")
        if (!cli.isFile) throw GradleException("Install locked dependencies before building: $cli")
        execOperations.exec {
            workingDir(File(project.projectDir, rustRoot))
            executable(System.getenv("LUCKYRAY_NODE") ?: "node")
            args(cli.absolutePath, "android", "android-studio-script")
            if (project.logger.isEnabled(LogLevel.DEBUG)) args("-vv")
            else if (project.logger.isEnabled(LogLevel.INFO)) args("-v")
            if (isRelease) args("--release")
            args("--target", rustTarget)
        }.assertNormalExitValue()
    }
}
