import { Argument, Command } from "commander";
import { withOutput } from "../../output/index.js";
import { addJsonAndDaemonHostOptions } from "../../utils/command-options.js";
import { runCreateCommand } from "./create.js";
import { runDeleteCommand } from "./delete.js";
import { runLsCommand } from "./ls.js";
import { runRenameCommand } from "./rename.js";
import {
  addProjectHarnessPlanOption,
  addProjectHarnessReleaseOptions,
  addProjectHarnessTargetOptions,
  runProjectHarnessApplyCommand,
  runProjectHarnessInspectCommand,
  runProjectHarnessPreviewCommand,
  runProjectHarnessReleaseCommand,
  runProjectHarnessUpdateCommand,
} from "./harness.js";

export function createProjectCommand(): Command {
  const project = new Command("project").description("Manage projects");

  addJsonAndDaemonHostOptions(
    project
      .command("create")
      .description("Register a project directory")
      .argument("[path]", "Project directory (default: current directory)"),
  ).action(withOutput(runCreateCommand));

  addJsonAndDaemonHostOptions(project.command("ls").description("List projects")).action(
    withOutput(runLsCommand),
  );

  addJsonAndDaemonHostOptions(
    project
      .command("rename")
      .description("Set a project's user-visible name")
      .argument("<project-id>", "Project id")
      .argument("[name]", "New project name")
      .option("--reset", "Clear the custom name and use the directory name")
      .allowExcessArguments(false),
  ).action(withOutput(runRenameCommand));

  addJsonAndDaemonHostOptions(
    project
      .command("delete")
      .description("Delete a project and its workspaces")
      .argument("<project-id>", "Project id"),
  ).action(withOutput(runDeleteCommand));

  const harness = project
    .command("harness")
    .description("Inspect and update Project Harness files");

  addProjectHarnessTargetOptions(
    addJsonAndDaemonHostOptions(
      harness
        .command("inspect")
        .description("Inspect a registered workspace Project Harness")
        .argument("<project-id>", "Project id"),
    ),
  ).action(withOutput(runProjectHarnessInspectCommand));

  addProjectHarnessTargetOptions(
    addJsonAndDaemonHostOptions(
      harness
        .command("preview")
        .description("Preview a guarded Project Harness plan")
        .argument("<project-id>", "Project id")
        .addArgument(
          new Argument("<operation>", "bootstrap or update").choices(["bootstrap", "update"]),
        ),
    ),
  ).action(withOutput(runProjectHarnessPreviewCommand));

  addProjectHarnessPlanOption(
    addProjectHarnessTargetOptions(
      addJsonAndDaemonHostOptions(
        harness
          .command("apply")
          .description("Apply a guarded Project Harness plan returned by preview")
          .argument("<project-id>", "Project id"),
      ),
    ),
  ).action(withOutput(runProjectHarnessApplyCommand));

  addProjectHarnessPlanOption(
    addProjectHarnessTargetOptions(
      addJsonAndDaemonHostOptions(
        harness
          .command("update")
          .description("Update a Project Harness with a guarded plan returned by preview")
          .argument("<project-id>", "Project id"),
      ),
    ),
  ).action(withOutput(runProjectHarnessUpdateCommand));

  addProjectHarnessReleaseOptions(
    addProjectHarnessTargetOptions(
      addJsonAndDaemonHostOptions(
        harness
          .command("release")
          .description("Release the current Project Harness notebook writer")
          .argument("<project-id>", "Project id"),
      ),
    ),
  ).action(withOutput(runProjectHarnessReleaseCommand));

  return project;
}
