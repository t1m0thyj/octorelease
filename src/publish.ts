import * as fs from "fs";
import * as path from "path";
import * as core from "@actions/core";
import * as github from "@actions/github";
import * as exec from "@actions/exec";
import { IProtectedBranch } from "./doc/IProtectedBranch";
import * as utils from "./utils";

export async function publishGithub(): Promise<void> {
    const changelogFile = "CHANGELOG.md";
    const packageJson = JSON.parse(fs.readFileSync("package.json").toString());
    let releaseNotes = "";

    // Try to find release notes in changelog
    if (fs.existsSync(changelogFile)) {
        const changelogLines: string[] = fs.readFileSync(changelogFile).toString().split(/\r?\n/);

        let lineNum = changelogLines.indexOf("## `" + packageJson.version + "`");
        if (lineNum !== -1) {
            while (changelogLines[lineNum + 1] && !changelogLines[lineNum + 1].startsWith("##")) {
                releaseNotes += changelogLines[lineNum + 1] + "\n";
                lineNum++;
            }
        } else {
            core.warning(`Missing changelog header for version ${packageJson.version}`);
        }
    } else {
        core.warning("Missing changelog file");
    }

    // Get release created by version stage
    const octokit = github.getOctokit(core.getInput("repo-token"));
    const [owner, repo] = utils.requireEnvVar("GITHUB_REPOSITORY").split("/", 2);
    const tag = "v" + packageJson.version;
    const release = await octokit.repos.getReleaseByTag({ owner, repo, tag });

    if (!release) {
        core.setFailed(`Could not find GitHub release matching the tag ${tag}`);
        process.exit();
        return;
    }

    const release_id = release.data.id;

    // Add release notes to body of release
    if (releaseNotes) {
        await octokit.repos.updateRelease({
            owner, repo, release_id,
            body: releaseNotes
        })
    }

    // Upload artifacts to release
    const artifactPaths: string[] = core.getInput("github-artifacts").split(",").map(s => s.trim());
    const mime = require("mime-types");
    for (const artifactPath of artifactPaths) {
        await octokit.repos.uploadReleaseAsset({
            owner, repo, release_id,
            name: path.basename(artifactPath),
            data: fs.readFileSync(artifactPath).toString(),
            url: release.data.upload_url,
            headers: {
                "Content-Type": mime.lookup(artifactPath)
            }
        })
    }
}

export async function publishNpm(branch: IProtectedBranch): Promise<void> {
    // Prevent publish from being affected by local npmrc
    await exec.exec("rm -f .npmrc");

    const packageJson = JSON.parse(fs.readFileSync("package.json").toString());
    // Need to remove trailing slash from registry URL for npm-cli-login
    const npmRegistry = packageJson.publishConfig?.registry?.replace(/\/$/, "");

    if (!npmRegistry) {
        core.setFailed("Expected NPM registry to be defined in package.json but it is not");
        process.exit();
    }

    // Login to registry in global npmrc
    const npmLogin = require("npm-cli-login");
    const [npmUsername, npmPassword] = core.getInput("npm-credentials").split(":", 2);
    const npmEmail = core.getInput("npm-email");
    const npmScope = packageJson.name.split("/")[0];
    npmLogin(npmUsername, npmPassword, npmEmail, npmRegistry, npmScope);

    const publishedVersion = await utils.getPackageVersion(packageJson.name, branch.tag);
    const latestVersion = packageJson.version;

    // Publish package
    if (publishedVersion != latestVersion) {
        await exec.exec(`npm publish --tag ${branch.tag}`);
    } else {
        core.warning(`Version ${publishedVersion} has already been published, skipping publish`);
    }

    // Add alias tags
    if (branch.aliasTags) {
        for (const tag of branch.aliasTags) {
            await exec.exec(`npm dist-tag add ${packageJson.name}@${latestVersion} ${tag}`);
        }
    }
}
