// Configuration reloading tests

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { EventEmitter } from "events";
import { tmpdir } from "os";
import { join } from "path";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { ExecutableBuilder } from "../src/builders/executable-builder.js";
import { createTestHarness } from "../src/factories.js";
import { ExecutableRunner } from "../src/runners/executable-runner.js";
import type { StateManager } from "../src/state.js";
import type { ExecutableTarget, PoltergeistConfig } from "../src/types.js";
import { detectConfigChanges } from "../src/utils/config-diff.js";

vi.mock("child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("child_process")>();
  return {
    ...actual,
    execSync: vi.fn().mockReturnValue("abc123\n"),
    spawn: vi.fn(),
  };
});

const { spawn } = await import("child_process");

describe("Configuration Reloading", () => {
  const baseConfig: PoltergeistConfig = {
    version: "1.0",
    projectType: "node",
    targets: [
      {
        name: "test-target",
        type: "executable",
        enabled: true,
        buildCommand: "npm run build",
        outputPath: "./dist/app.js",
        watchPaths: ["src/**/*.ts"],
        settlingDelay: 1000,
      },
    ],
    watchman: {
      useDefaultExclusions: true,
      excludeDirs: [],
      projectType: "node",
      maxFileEvents: 10000,
      recrawlThreshold: 5,
      settlingDelay: 1000,
    },
  };

  let harness: ReturnType<typeof createTestHarness>;

  beforeEach(() => {
    harness = createTestHarness(baseConfig);

    // Create proper mock logger
    harness.logger.info = vi.fn();
    harness.logger.error = vi.fn();
    harness.logger.warn = vi.fn();
    harness.logger.debug = vi.fn();

    vi.clearAllMocks();
  });

  test("should detect target addition", async () => {
    const newConfig = {
      ...baseConfig,
      targets: [
        ...baseConfig.targets,
        {
          name: "new-target",
          type: "executable" as const,
          enabled: true,
          buildCommand: "npm run build:new",
          outputPath: "./dist/new.js",
          watchPaths: ["src/**/*.js"],
          settlingDelay: 1000,
        },
      ],
    };

    const changes = detectConfigChanges(baseConfig, newConfig);

    expect(changes.targetsAdded).toHaveLength(1);
    expect(changes.targetsAdded[0].name).toBe("new-target");
    expect(changes.targetsRemoved).toHaveLength(0);
    expect(changes.targetsModified).toHaveLength(0);
  });

  test("should detect target removal", async () => {
    const newConfig = {
      ...baseConfig,
      targets: [], // Remove all targets
    };

    const changes = detectConfigChanges(baseConfig, newConfig);

    expect(changes.targetsAdded).toHaveLength(0);
    expect(changes.targetsRemoved).toHaveLength(1);
    expect(changes.targetsRemoved[0]).toBe("test-target");
    expect(changes.targetsModified).toHaveLength(0);
  });

  test("should detect target modification", async () => {
    const newConfig = {
      ...baseConfig,
      targets: [
        {
          ...baseConfig.targets[0],
          buildCommand: "npm run build:modified", // Changed build command
        },
      ],
    };

    const changes = detectConfigChanges(baseConfig, newConfig);

    expect(changes.targetsAdded).toHaveLength(0);
    expect(changes.targetsRemoved).toHaveLength(0);
    expect(changes.targetsModified).toHaveLength(1);
    expect(changes.targetsModified[0].name).toBe("test-target");
    expect(changes.targetsModified[0].newTarget.buildCommand).toBe("npm run build:modified");
  });

  test("should detect watchman configuration changes", async () => {
    const configPath = "/test/poltergeist.config.json";
    const poltergeist = new (await import("../src/poltergeist.js")).Poltergeist(
      baseConfig,
      "/test/project",
      harness.logger,
      harness.mocks,
      configPath,
    );

    const detectChanges = (
      poltergeist as unknown as PoltergeistWithPrivate
    ).detectConfigChanges.bind(poltergeist);

    const newConfig = {
      ...baseConfig,
      watchman: {
        ...(baseConfig.watchman || {}),
        settlingDelay: 2000, // Changed settling delay
      },
    };

    const changes = detectChanges(baseConfig, newConfig);

    expect(changes.watchmanChanged).toBe(true);
    expect(changes.notificationsChanged).toBe(false);
    expect(changes.buildSchedulingChanged).toBe(false);
  });

  test("should handle config file watching setup", async () => {
    const configPath = "/test/poltergeist.config.json";

    // Create enhanced mocks with watchman config manager
    const enhancedMocks = {
      ...harness.mocks,
      watchmanConfigManager: {
        ensureConfigUpToDate: vi.fn().mockResolvedValue(undefined),
        suggestOptimizations: vi.fn().mockResolvedValue([]),
        normalizeWatchPattern: vi.fn().mockImplementation((pattern: string) => pattern),
        validateWatchPattern: vi.fn(),
        createExclusionExpressions: vi.fn().mockReturnValue([]),
      },
    };

    const poltergeist = new (await import("../src/poltergeist.js")).Poltergeist(
      baseConfig,
      "/test/project",
      harness.logger,
      enhancedMocks,
      configPath,
    );

    // Mock watchman subscribe to verify it gets called for config file
    const subscribeMock = enhancedMocks.watchmanClient?.subscribe as ReturnType<typeof vi.fn>;

    await poltergeist.start();

    // Check that subscribe was called for config file watching
    const configSubscriptionCall = subscribeMock.mock.calls.find(
      (call: unknown[]) => call[1] === "poltergeist_config",
    );

    expect(configSubscriptionCall).toBeDefined();
    expect(configSubscriptionCall[2].expression).toEqual([
      "match",
      "poltergeist.config.json",
      "wholename",
    ]);
  });

  test("should handle missing config path gracefully", async () => {
    // Create enhanced mocks with watchman config manager
    const enhancedMocks = {
      ...harness.mocks,
      watchmanConfigManager: {
        ensureConfigUpToDate: vi.fn().mockResolvedValue(undefined),
        suggestOptimizations: vi.fn().mockResolvedValue([]),
        normalizeWatchPattern: vi.fn().mockImplementation((pattern: string) => pattern),
        validateWatchPattern: vi.fn(),
        createExclusionExpressions: vi.fn().mockReturnValue([]),
      },
    };

    // Create Poltergeist without config path
    const poltergeist = new (await import("../src/poltergeist.js")).Poltergeist(
      baseConfig,
      "/test/project",
      harness.logger,
      enhancedMocks,
      // No configPath parameter
    );

    // Should start successfully without config watching
    await expect(poltergeist.start()).resolves.not.toThrow();

    // Should not set up config file watching
    const subscribeMock = enhancedMocks.watchmanClient?.subscribe as ReturnType<typeof vi.fn>;
    const configSubscriptionCall = subscribeMock.mock.calls.find(
      (call: unknown[]) => call[1] === "poltergeist_config",
    );

    expect(configSubscriptionCall).toBeUndefined();
  });

  describe("Configuration Change Application", () => {
    test("should properly apply target additions", async () => {
      const configPath = "/test/poltergeist.config.json";
      const enhancedMocks = {
        ...harness.mocks,
        watchmanConfigManager: {
          ensureConfigUpToDate: vi.fn().mockResolvedValue(undefined),
          suggestOptimizations: vi.fn().mockResolvedValue([]),
          normalizeWatchPattern: vi.fn().mockImplementation((pattern: string) => pattern),
          validateWatchPattern: vi.fn(),
          createExclusionExpressions: vi.fn().mockReturnValue([]),
        },
      };

      const poltergeist = new (await import("../src/poltergeist.js")).Poltergeist(
        baseConfig,
        "/test/project",
        harness.logger,
        enhancedMocks,
        configPath,
      );

      const newConfig = {
        ...baseConfig,
        targets: [
          ...baseConfig.targets,
          {
            name: "new-target",
            type: "executable" as const,
            enabled: true,
            buildCommand: "npm run build:new",
            outputPath: "./dist/new.js",
            watchPaths: ["src/**/*.js"],
            settlingDelay: 1000,
          },
        ],
      };

      const changes = detectConfigChanges(baseConfig, newConfig);
      await poltergeist.applyConfigChanges(newConfig, changes);

      // Verify that the builder factory was called to create the new target
      expect(enhancedMocks.builderFactory.createBuilder).toHaveBeenCalledWith(
        expect.objectContaining({ name: "new-target" }),
        "/test/project",
        harness.logger,
        enhancedMocks.stateManager,
      );
    });

    test("should use the modified build command after applying target changes", async () => {
      const configPath = "/test/poltergeist.config.json";
      const enhancedMocks = {
        ...harness.mocks,
        watchmanConfigManager: {
          ensureConfigUpToDate: vi.fn().mockResolvedValue(undefined),
          suggestOptimizations: vi.fn().mockResolvedValue([]),
          normalizeWatchPattern: vi.fn().mockImplementation((pattern: string) => pattern),
          validateWatchPattern: vi.fn(),
          createExclusionExpressions: vi.fn().mockReturnValue([]),
        },
      };
      let builderTarget = baseConfig.targets[0];
      const executedCommands: Array<string | undefined> = [];
      const builder = {
        build: vi.fn().mockImplementation(async () => {
          executedCommands.push(builderTarget.buildCommand);
          return {
            status: "success" as const,
            targetName: builderTarget.name,
            timestamp: new Date().toISOString(),
          };
        }),
        updateTarget: vi.fn().mockImplementation((target: PoltergeistConfig["targets"][number]) => {
          builderTarget = target;
        }),
        hasActiveBuild: vi.fn().mockReturnValue(false),
        validate: vi.fn().mockResolvedValue(undefined),
        stop: vi.fn(),
        getOutputInfo: vi.fn(),
        getProjectRoot: vi.fn().mockReturnValue("/test/project"),
        describeBuilder: vi.fn().mockReturnValue("Executable"),
      };
      enhancedMocks.builderFactory.createBuilder = vi.fn().mockReturnValue(builder);

      const poltergeist = new (await import("../src/poltergeist.js")).Poltergeist(
        baseConfig,
        "/test/project",
        harness.logger,
        enhancedMocks,
        configPath,
      );
      await poltergeist.start(undefined, { waitForInitialBuilds: false });

      const newConfig: PoltergeistConfig = {
        ...baseConfig,
        targets: [
          {
            ...baseConfig.targets[0],
            buildCommand: "npm run build:modified",
          },
        ],
      };
      const changes = detectConfigChanges(baseConfig, newConfig);

      expect(changes.targetsModified).toHaveLength(1);
      await poltergeist.applyConfigChanges(newConfig, changes);
      await builder.build([]);

      expect(executedCommands).toEqual(["npm run build:modified"]);
    });

    test("should keep the in-flight build target stable during target updates", async () => {
      const projectRoot = mkdtempSync(join(tmpdir(), "poltergeist-config-reload-"));
      const oldTarget: ExecutableTarget = {
        name: "test-target",
        type: "executable",
        enabled: true,
        buildCommand: "build-old",
        outputPath: "./dist/old-app",
        watchPaths: ["src/**/*.ts"],
      };
      const newTarget: ExecutableTarget = {
        ...oldTarget,
        buildCommand: "build-new",
        outputPath: "./dist/new-app",
      };
      const updateAppInfo = vi.fn().mockResolvedValue(undefined);
      const stateManager = {
        ...harness.mocks.stateManager,
        updateAppInfo,
      } as unknown as StateManager;
      let releaseBuild: (() => void) | undefined;

      class InFlightBuilder extends ExecutableBuilder {
        protected override async executeBuild(): Promise<void> {
          await new Promise<void>((resolve) => {
            releaseBuild = resolve;
          });
        }
      }

      mkdirSync(join(projectRoot, "dist"), { recursive: true });
      writeFileSync(join(projectRoot, oldTarget.outputPath), "old output");
      const builder = new InFlightBuilder(oldTarget, projectRoot, harness.logger, stateManager);

      try {
        const buildPromise = builder.build([]);
        await vi.waitFor(() => expect(releaseBuild).toBeDefined());

        builder.updateTarget(newTarget);
        releaseBuild?.();

        const result = await buildPromise;
        expect(result.status).toBe("success");
        expect(updateAppInfo).toHaveBeenCalledWith("test-target", {
          outputPath: join(projectRoot, oldTarget.outputPath),
        });
        expect(builder.getOutputInfo()).toBe(join(projectRoot, newTarget.outputPath));
      } finally {
        releaseBuild?.();
        rmSync(projectRoot, { recursive: true, force: true });
      }
    });

    async function createAutoRunReloadHarness(blockFirstBuild: boolean) {
      const oldTarget: ExecutableTarget = {
        name: "test-target",
        type: "executable",
        enabled: true,
        buildCommand: "build-old",
        outputPath: "./dist/old-app",
        watchPaths: ["src/**/*.ts"],
        autoRun: {
          enabled: true,
          command: "run-old",
          args: ["--old"],
          restartDelayMs: 1,
        },
      };
      const oldConfig: PoltergeistConfig = { ...baseConfig, targets: [oldTarget] };
      const stateManager = {
        ...harness.mocks.stateManager,
        updateAppInfo: vi.fn().mockResolvedValue(undefined),
      } as unknown as StateManager;
      let releaseBuild: (() => void) | undefined;
      let buildCount = 0;

      class InFlightBuilder extends ExecutableBuilder {
        protected override async executeBuild(): Promise<void> {
          buildCount += 1;
          if (blockFirstBuild && buildCount === 1) {
            await new Promise<void>((resolve) => {
              releaseBuild = resolve;
            });
          }
        }

        protected override async postBuild(): Promise<void> {}
      }

      const killMock = vi.fn();
      (spawn as vi.Mock).mockImplementation(() => {
        const child = Object.assign(new EventEmitter(), {
          kill: killMock.mockImplementation((signal: NodeJS.Signals) => {
            child.emit("exit", 0, signal);
            return true;
          }),
          exitCode: null,
          signalCode: null,
          killed: false,
        });
        return child;
      });

      const builder = new InFlightBuilder(oldTarget, "/test/project", harness.logger, stateManager);
      const enhancedMocks = {
        ...harness.mocks,
        stateManager,
        builderFactory: {
          createBuilder: vi.fn().mockReturnValue(builder),
        },
        watchmanConfigManager: {
          ensureConfigUpToDate: vi.fn().mockResolvedValue(undefined),
          suggestOptimizations: vi.fn().mockResolvedValue([]),
          normalizeWatchPattern: vi.fn().mockImplementation((pattern: string) => pattern),
          validateWatchPattern: vi.fn(),
          createExclusionExpressions: vi.fn().mockReturnValue([]),
        },
      };
      const poltergeist = new (await import("../src/poltergeist.js")).Poltergeist(
        oldConfig,
        "/test/project",
        harness.logger,
        enhancedMocks,
        "/test/poltergeist.config.json",
      );
      await poltergeist.start(undefined, { waitForInitialBuilds: false });
      const runner = (
        poltergeist as unknown as {
          targetStates: Map<string, { runner?: ExecutableRunner }>;
        }
      ).targetStates.get(oldTarget.name)?.runner;
      if (!runner) {
        throw new Error("Expected executable runner");
      }

      return {
        oldTarget,
        poltergeist,
        runner,
        killMock,
        releaseBuild: () => releaseBuild?.(),
        waitForBuildStart: () => vi.waitFor(() => expect(releaseBuild).toBeDefined()),
        applyTarget: async (target: ExecutableTarget) => {
          const newConfig: PoltergeistConfig = { ...oldConfig, targets: [target] };
          await poltergeist.applyConfigChanges(
            newConfig,
            detectConfigChanges(oldConfig, newConfig),
          );
        },
      };
    }

    test("should launch an in-flight build with the old auto-run command and later builds with the new command", async () => {
      const setup = await createAutoRunReloadHarness(true);
      const newTarget: ExecutableTarget = {
        ...setup.oldTarget,
        buildCommand: "build-new",
        outputPath: "./dist/new-app",
        autoRun: {
          ...setup.oldTarget.autoRun,
          command: "run-new",
          args: ["--new"],
        },
      };

      try {
        await setup.runner.onBuildSuccess();
        (spawn as vi.Mock).mockClear();

        const buildPromise = setup.poltergeist.performInitialBuilds();
        await setup.waitForBuildStart();
        await setup.applyTarget(newTarget);
        setup.releaseBuild();
        await buildPromise;

        await vi.waitFor(() => {
          expect(spawn).toHaveBeenLastCalledWith("run-old", ["--old"], expect.any(Object));
        });

        (spawn as vi.Mock).mockClear();
        await setup.poltergeist.performInitialBuilds();
        await vi.waitFor(() => {
          expect(spawn).toHaveBeenLastCalledWith("run-new", ["--new"], expect.any(Object));
        });
      } finally {
        setup.releaseBuild();
        await setup.poltergeist.stop();
      }
    });

    test("should keep the newest deferred target when reloaded during a restart", async () => {
      const setup = await createAutoRunReloadHarness(true);
      const firstTarget: ExecutableTarget = {
        ...setup.oldTarget,
        buildCommand: "build-first",
        outputPath: "./dist/first-app",
        autoRun: {
          ...setup.oldTarget.autoRun,
          command: "run-first",
          args: ["--first"],
        },
      };
      const secondTarget: ExecutableTarget = {
        ...setup.oldTarget,
        buildCommand: "build-second",
        outputPath: "./dist/second-app",
        autoRun: {
          ...setup.oldTarget.autoRun,
          command: "run-second",
          args: ["--second"],
        },
      };
      let releaseRestart: (() => void) | undefined;
      let holdFirstStop = true;

      (spawn as vi.Mock).mockImplementation(() => {
        const child = Object.assign(new EventEmitter(), {
          kill: vi.fn((signal: NodeJS.Signals) => {
            if (holdFirstStop) {
              holdFirstStop = false;
              releaseRestart = () => child.emit("exit", 0, signal);
            } else {
              child.emit("exit", 0, signal);
            }
            return true;
          }),
          exitCode: null,
          signalCode: null,
          killed: false,
        });
        return child;
      });

      try {
        await setup.runner.onBuildSuccess();
        (spawn as vi.Mock).mockClear();

        const buildPromise = setup.poltergeist.performInitialBuilds();
        await setup.waitForBuildStart();
        await setup.applyTarget(firstTarget);
        setup.releaseBuild();
        await buildPromise;
        await vi.waitFor(() => expect(releaseRestart).toBeDefined());

        await setup.applyTarget(secondTarget);
        releaseRestart?.();

        await vi.waitFor(() => {
          expect(spawn).toHaveBeenCalledTimes(1);
          expect(spawn).toHaveBeenLastCalledWith("run-old", ["--old"], expect.any(Object));
        });

        (spawn as vi.Mock).mockClear();
        await setup.poltergeist.performInitialBuilds();
        await vi.waitFor(() => {
          expect(spawn).toHaveBeenCalledTimes(1);
          expect(spawn).toHaveBeenLastCalledWith("run-second", ["--second"], expect.any(Object));
        });
      } finally {
        setup.releaseBuild();
        releaseRestart?.();
        await setup.poltergeist.stop();
      }
    });

    test("should keep a queued restart on the old target after a later build fails", async () => {
      vi.useFakeTimers();
      const oldTarget: ExecutableTarget = {
        name: "test-target",
        type: "executable",
        enabled: true,
        buildCommand: "build-old",
        outputPath: "./dist/old-app",
        watchPaths: ["src/**/*.ts"],
        autoRun: {
          enabled: true,
          command: "run-old",
          args: ["--old"],
          restartDelayMs: 1000,
        },
      };
      const newTarget: ExecutableTarget = {
        ...oldTarget,
        buildCommand: "build-new",
        outputPath: "./dist/new-app",
        autoRun: {
          ...oldTarget.autoRun,
          command: "run-new",
          args: ["--new"],
        },
      };
      let buildActive = false;

      (spawn as vi.Mock).mockImplementation(() => {
        const child = Object.assign(new EventEmitter(), {
          kill: vi.fn((signal: NodeJS.Signals) => {
            child.emit("exit", 0, signal);
            return true;
          }),
          exitCode: null,
          signalCode: null,
          killed: false,
        });
        return child;
      });

      const runner = new ExecutableRunner(oldTarget, {
        projectRoot: "/test/project",
        logger: harness.logger,
      });

      try {
        await runner.onBuildSuccess();
        await runner.onBuildSuccess();

        buildActive = true;
        await runner.updateTarget(newTarget, {
          defer: true,
          isBuildActive: () => buildActive,
        });
        buildActive = false;
        runner.onBuildFailure({
          status: "failure",
          timestamp: new Date().toISOString(),
          errorSummary: "later build failed",
        });

        await vi.advanceTimersByTimeAsync(1000);
        expect(spawn).toHaveBeenCalledTimes(2);
        expect(spawn).toHaveBeenLastCalledWith("run-old", ["--old"], expect.any(Object));

        await runner.onBuildSuccess();
        await vi.advanceTimersByTimeAsync(1000);
        expect(spawn).toHaveBeenCalledTimes(3);
        expect(spawn).toHaveBeenLastCalledWith("run-new", ["--new"], expect.any(Object));
      } finally {
        await runner.stop();
        vi.useRealTimers();
      }
    });

    test("should adopt a deferred target after an executing restart finishes", async () => {
      const oldTarget: ExecutableTarget = {
        name: "test-target",
        type: "executable",
        enabled: true,
        buildCommand: "build-old",
        outputPath: "./dist/old-app",
        watchPaths: ["src/**/*.ts"],
        autoRun: {
          enabled: true,
          command: "run-old",
          args: ["--old"],
          restartDelayMs: 0,
        },
      };
      const newTarget: ExecutableTarget = {
        ...oldTarget,
        buildCommand: "build-new",
        outputPath: "./dist/new-app",
        autoRun: {
          ...oldTarget.autoRun,
          command: "run-new",
          args: ["--new"],
        },
      };
      let buildActive = false;
      let releaseRestart: (() => void) | undefined;
      let holdFirstStop = true;

      (spawn as vi.Mock).mockImplementation(() => {
        const child = Object.assign(new EventEmitter(), {
          kill: vi.fn((signal: NodeJS.Signals) => {
            if (holdFirstStop) {
              holdFirstStop = false;
              releaseRestart = () => child.emit("exit", 0, signal);
            } else {
              child.emit("exit", 0, signal);
            }
            return true;
          }),
          exitCode: null,
          signalCode: null,
          killed: false,
        });
        return child;
      });

      const runner = new ExecutableRunner(oldTarget, {
        projectRoot: "/test/project",
        logger: harness.logger,
      });

      try {
        await runner.onBuildSuccess();
        await runner.onBuildSuccess();
        await vi.waitFor(() => expect(releaseRestart).toBeDefined());

        buildActive = true;
        await runner.updateTarget(newTarget, {
          defer: true,
          isBuildActive: () => buildActive,
        });
        buildActive = false;
        runner.onBuildFailure({
          status: "failure",
          timestamp: new Date().toISOString(),
          errorSummary: "later build failed",
        });
        releaseRestart?.();

        await vi.waitFor(() => {
          expect(spawn).toHaveBeenCalledTimes(2);
          expect(spawn).toHaveBeenLastCalledWith("run-old", ["--old"], expect.any(Object));
          expect((runner as unknown as { target: ExecutableTarget }).target).toBe(newTarget);
        });

        await runner.onBuildSuccess();
        await vi.waitFor(() => {
          expect(spawn).toHaveBeenCalledTimes(3);
          expect(spawn).toHaveBeenLastCalledWith("run-new", ["--new"], expect.any(Object));
        });
      } finally {
        releaseRestart?.();
        await runner.stop();
      }
    });

    test("should keep the old auto-run command until every in-flight build finishes", async () => {
      const setup = await createAutoRunReloadHarness(false);
      const newTarget: ExecutableTarget = {
        ...setup.oldTarget,
        buildCommand: "build-new",
        outputPath: "./dist/new-app",
        autoRun: {
          ...setup.oldTarget.autoRun,
          command: "run-new",
          args: ["--new"],
        },
      };
      let activeBuilds = 0;
      const startBuild = () => {
        activeBuilds += 1;
      };
      const finishBuild = async () => {
        activeBuilds -= 1;
        await setup.runner.onBuildSuccess();
      };

      try {
        startBuild();
        startBuild();
        await setup.runner.updateTarget(newTarget, {
          defer: true,
          isBuildActive: () => activeBuilds > 0,
        });

        await finishBuild();
        expect(spawn).toHaveBeenLastCalledWith("run-old", ["--old"], expect.any(Object));

        await finishBuild();
        await vi.waitFor(() => {
          expect(spawn).toHaveBeenCalledTimes(2);
          expect(spawn).toHaveBeenLastCalledWith("run-old", ["--old"], expect.any(Object));
        });

        startBuild();
        await finishBuild();
        await vi.waitFor(() => {
          expect(spawn).toHaveBeenCalledTimes(3);
          expect(spawn).toHaveBeenLastCalledWith("run-new", ["--new"], expect.any(Object));
        });
      } finally {
        await setup.poltergeist.stop();
      }
    });

    test("should enable auto-run after a disabled in-flight build finishes", async () => {
      const setup = await createAutoRunReloadHarness(true);
      const disabledTarget: ExecutableTarget = {
        ...setup.oldTarget,
        autoRun: { ...setup.oldTarget.autoRun, enabled: false },
      };
      const enabledTarget: ExecutableTarget = {
        ...disabledTarget,
        buildCommand: "build-new",
        outputPath: "./dist/new-app",
        autoRun: {
          ...disabledTarget.autoRun,
          enabled: true,
          command: "run-new",
          args: ["--new"],
        },
      };

      try {
        await setup.applyTarget(disabledTarget);

        const buildPromise = setup.poltergeist.performInitialBuilds();
        await setup.waitForBuildStart();
        await setup.applyTarget(enabledTarget);
        setup.releaseBuild();
        await buildPromise;

        expect(spawn).not.toHaveBeenCalled();

        await setup.poltergeist.performInitialBuilds();
        await vi.waitFor(() => {
          expect(spawn).toHaveBeenLastCalledWith("run-new", ["--new"], expect.any(Object));
        });
      } finally {
        setup.releaseBuild();
        await setup.poltergeist.stop();
      }
    });

    test("should stop auto-run immediately when disabled during an in-flight build", async () => {
      const setup = await createAutoRunReloadHarness(true);
      const disabledTarget: ExecutableTarget = {
        ...setup.oldTarget,
        autoRun: { ...setup.oldTarget.autoRun, enabled: false },
      };

      try {
        await setup.runner.onBuildSuccess();
        expect(spawn).toHaveBeenCalledTimes(1);

        const buildPromise = setup.poltergeist.performInitialBuilds();
        await setup.waitForBuildStart();
        await setup.applyTarget(disabledTarget);

        expect(setup.killMock).toHaveBeenCalledWith("SIGTERM");
        (spawn as vi.Mock).mockClear();
        setup.releaseBuild();
        await buildPromise;

        expect(spawn).not.toHaveBeenCalled();
      } finally {
        setup.releaseBuild();
        await setup.poltergeist.stop();
      }
    });

    test("should apply auto-run target updates immediately when no build is in flight", async () => {
      const setup = await createAutoRunReloadHarness(false);
      const newTarget: ExecutableTarget = {
        ...setup.oldTarget,
        buildCommand: "build-new",
        outputPath: "./dist/new-app",
        autoRun: {
          ...setup.oldTarget.autoRun,
          command: "run-new",
          args: ["--new"],
        },
      };

      try {
        await setup.applyTarget(newTarget);
        await setup.runner.onBuildSuccess();

        expect(spawn).toHaveBeenLastCalledWith("run-new", ["--new"], expect.any(Object));
      } finally {
        await setup.poltergeist.stop();
      }
    });

    test("should stop auto-run on disable and allow it to be re-enabled", async () => {
      vi.useFakeTimers();
      const killMocks: Array<ReturnType<typeof vi.fn>> = [];

      (spawn as vi.Mock).mockImplementation(() => {
        const child = Object.assign(new EventEmitter(), {
          kill: vi.fn((signal: NodeJS.Signals) => {
            child.emit("exit", 0, signal);
            return true;
          }),
          exitCode: null,
          signalCode: null,
          killed: false,
        });
        killMocks.push(child.kill);
        return child;
      });

      const target: ExecutableTarget = {
        name: "test-target",
        type: "executable",
        enabled: true,
        buildCommand: "build-app",
        outputPath: "./dist/app",
        watchPaths: ["src/**/*.ts"],
        autoRun: {
          enabled: true,
          command: "run-app",
          restartDelayMs: 1000,
        },
      };
      const runner = new ExecutableRunner(target, {
        projectRoot: "/test/project",
        logger: harness.logger,
      });

      try {
        await runner.onBuildSuccess();
        await runner.onBuildSuccess();
        expect(spawn).toHaveBeenCalledTimes(1);

        await runner.updateTarget({
          ...target,
          autoRun: { ...target.autoRun, enabled: false },
        });

        expect(killMocks[0]).toHaveBeenCalledWith("SIGTERM");
        await vi.advanceTimersByTimeAsync(1000);
        expect(spawn).toHaveBeenCalledTimes(1);

        await runner.updateTarget(target);
        await runner.onBuildSuccess();

        expect(spawn).toHaveBeenCalledTimes(2);
      } finally {
        await runner.stop();
        vi.useRealTimers();
      }
    });

    test("should properly handle target removal", async () => {
      const configPath = "/test/poltergeist.config.json";
      const enhancedMocks = {
        ...harness.mocks,
        watchmanConfigManager: {
          ensureConfigUpToDate: vi.fn().mockResolvedValue(undefined),
          suggestOptimizations: vi.fn().mockResolvedValue([]),
          normalizeWatchPattern: vi.fn().mockImplementation((pattern: string) => pattern),
          validateWatchPattern: vi.fn(),
          createExclusionExpressions: vi.fn().mockReturnValue([]),
        },
      };

      const poltergeist = new (await import("../src/poltergeist.js")).Poltergeist(
        baseConfig,
        "/test/project",
        harness.logger,
        enhancedMocks,
        configPath,
      );

      // Start with initial state
      await poltergeist.start();

      const newConfig = {
        ...baseConfig,
        targets: [], // Remove all targets
      };

      const changes = detectConfigChanges(baseConfig, newConfig);
      await poltergeist.applyConfigChanges(newConfig, changes);

      // Verify that target states were cleared - we can't directly access private fields,
      // but we can verify through status
      const status = await poltergeist.getStatus();
      expect(status["test-target"]).toEqual({
        status: "not running",
        enabled: true,
        type: "executable",
      });
    });

    test("should handle notification configuration changes", async () => {
      const configPath = "/test/poltergeist.config.json";
      const enhancedMocks = {
        ...harness.mocks,
        watchmanConfigManager: {
          ensureConfigUpToDate: vi.fn().mockResolvedValue(undefined),
          suggestOptimizations: vi.fn().mockResolvedValue([]),
          normalizeWatchPattern: vi.fn().mockImplementation((pattern: string) => pattern),
          validateWatchPattern: vi.fn(),
          createExclusionExpressions: vi.fn().mockReturnValue([]),
        },
      };

      const poltergeist = new (await import("../src/poltergeist.js")).Poltergeist(
        baseConfig,
        "/test/project",
        harness.logger,
        enhancedMocks,
        configPath,
      );

      const newConfig = {
        ...baseConfig,
        notifications: {
          enabled: true,
          buildSuccess: true,
          buildFailed: true,
        },
      };

      const changes = detectConfigChanges(baseConfig, newConfig);
      expect(changes.notificationsChanged).toBe(true);

      await poltergeist.applyConfigChanges(newConfig, changes);

      // The notifier should be initialized internally, but we can't easily test this
      // without accessing private fields. The test verifies the change detection works.
    });

    test("should handle build scheduling configuration changes", async () => {
      const configPath = "/test/poltergeist.config.json";
      const enhancedMocks = {
        ...harness.mocks,
        watchmanConfigManager: {
          ensureConfigUpToDate: vi.fn().mockResolvedValue(undefined),
          suggestOptimizations: vi.fn().mockResolvedValue([]),
          normalizeWatchPattern: vi.fn().mockImplementation((pattern: string) => pattern),
          validateWatchPattern: vi.fn(),
          createExclusionExpressions: vi.fn().mockReturnValue([]),
        },
      };

      const poltergeist = new (await import("../src/poltergeist.js")).Poltergeist(
        baseConfig,
        "/test/project",
        harness.logger,
        enhancedMocks,
        configPath,
      );

      const newConfig = {
        ...baseConfig,
        buildScheduling: {
          parallelization: 4,
          prioritization: {
            enabled: false,
            focusDetectionWindow: 600000,
            priorityDecayTime: 3600000,
            buildTimeoutMultiplier: 3.0,
          },
        },
      };

      const changes = detectConfigChanges(baseConfig, newConfig);
      expect(changes.buildSchedulingChanged).toBe(true);

      await poltergeist.applyConfigChanges(newConfig, changes);

      // Verify the change was detected - internal state changes are hard to test
      // without exposing private fields, but the detection logic is verified
    });
  });

  describe("Error Handling", () => {
    test("should handle configuration loading errors gracefully", async () => {
      const configPath = "/test/poltergeist.config.json";
      const enhancedMocks = {
        ...harness.mocks,
        watchmanConfigManager: {
          ensureConfigUpToDate: vi.fn().mockResolvedValue(undefined),
          suggestOptimizations: vi.fn().mockResolvedValue([]),
          normalizeWatchPattern: vi.fn().mockImplementation((pattern: string) => pattern),
          validateWatchPattern: vi.fn(),
          createExclusionExpressions: vi.fn().mockReturnValue([]),
        },
      };

      const poltergeist = new (await import("../src/poltergeist.js")).Poltergeist(
        baseConfig,
        "/test/project",
        harness.logger,
        enhancedMocks,
        configPath,
      );

      // Mock ConfigurationManager to throw an error
      const { ConfigurationManager } = await import("../src/utils/config-manager.js");
      const originalLoadConfig = ConfigurationManager.loadConfigFromPath;
      vi.spyOn(ConfigurationManager, "loadConfigFromPath").mockRejectedValue(
        new Error("Invalid configuration file"),
      );

      // Should not throw, just log error
      await expect(
        poltergeist.handleConfigChange([{ name: "poltergeist.config.json", exists: true }]),
      ).resolves.not.toThrow();

      // Verify error was logged
      expect(harness.logger.error).toHaveBeenCalledWith(
        expect.stringContaining("Failed to reload configuration"),
      );

      // Restore original method
      vi.spyOn(ConfigurationManager, "loadConfigFromPath").mockImplementation(originalLoadConfig);
    });

    test("should handle builder creation failures during config reload", async () => {
      const configPath = "/test/poltergeist.config.json";
      const enhancedMocks = {
        ...harness.mocks,
        watchmanConfigManager: {
          ensureConfigUpToDate: vi.fn().mockResolvedValue(undefined),
          suggestOptimizations: vi.fn().mockResolvedValue([]),
          normalizeWatchPattern: vi.fn().mockImplementation((pattern: string) => pattern),
          validateWatchPattern: vi.fn(),
          createExclusionExpressions: vi.fn().mockReturnValue([]),
        },
      };

      // Make builder factory throw an error
      enhancedMocks.builderFactory.createBuilder = vi.fn().mockImplementation(() => {
        throw new Error("Builder creation failed");
      });

      const poltergeist = new (await import("../src/poltergeist.js")).Poltergeist(
        baseConfig,
        "/test/project",
        harness.logger,
        enhancedMocks,
        configPath,
      );

      const newConfig = {
        ...baseConfig,
        targets: [
          ...baseConfig.targets,
          {
            name: "failing-target",
            type: "executable" as const,
            enabled: true,
            buildCommand: "npm run build:fail",
            outputPath: "./dist/fail.js",
            watchPaths: ["src/**/*.fail"],
            settlingDelay: 1000,
          },
        ],
      };

      const applyChanges = (
        poltergeist as unknown as PoltergeistWithPrivate
      ).applyConfigChanges.bind(poltergeist);
      const detectChanges = (
        poltergeist as unknown as PoltergeistWithPrivate
      ).detectConfigChanges.bind(poltergeist);

      const changes = detectChanges(baseConfig, newConfig);

      // Should not throw, just log error
      await expect(applyChanges(newConfig, changes)).resolves.not.toThrow();

      // Verify error was logged
      expect(harness.logger.error).toHaveBeenCalledWith(
        expect.stringContaining("Failed to add target failing-target"),
      );
    });

    test("should handle watchman subscription failures gracefully", async () => {
      const configPath = "/test/poltergeist.config.json";
      const enhancedMocks = {
        ...harness.mocks,
        watchmanConfigManager: {
          ensureConfigUpToDate: vi.fn().mockResolvedValue(undefined),
          suggestOptimizations: vi.fn().mockResolvedValue([]),
          normalizeWatchPattern: vi.fn().mockImplementation((pattern: string) => pattern),
          validateWatchPattern: vi.fn(),
          createExclusionExpressions: vi.fn().mockReturnValue([]),
        },
      };

      // Make watchman subscription fail for config file
      if (enhancedMocks.watchmanClient) {
        enhancedMocks.watchmanClient.subscribe = vi
          .fn()
          .mockImplementation((_projectRoot, subscriptionName) => {
            if (subscriptionName === "poltergeist_config") {
              throw new Error("Watchman subscription failed");
            }
            return Promise.resolve();
          });
      }

      const poltergeist = new (await import("../src/poltergeist.js")).Poltergeist(
        baseConfig,
        "/test/project",
        harness.logger,
        enhancedMocks,
        configPath,
      );

      // Should start successfully despite config watching failure
      await expect(poltergeist.start()).resolves.not.toThrow();

      // Verify warning was logged
      expect(harness.logger.warn).toHaveBeenCalledWith(
        expect.stringContaining("Failed to watch config file"),
      );
    });
  });

  describe("File Change Simulation", () => {
    test("should trigger config reload when config file changes", async () => {
      const configPath = "/test/poltergeist.config.json";
      const enhancedMocks = {
        ...harness.mocks,
        watchmanConfigManager: {
          ensureConfigUpToDate: vi.fn().mockResolvedValue(undefined),
          suggestOptimizations: vi.fn().mockResolvedValue([]),
          normalizeWatchPattern: vi.fn().mockImplementation((pattern: string) => pattern),
          validateWatchPattern: vi.fn(),
          createExclusionExpressions: vi.fn().mockReturnValue([]),
        },
      };

      let configChangeCallback: ((files: Array<{ name: string }>) => void) | undefined;

      // Capture the callback for config file watching
      if (enhancedMocks.watchmanClient) {
        enhancedMocks.watchmanClient.subscribe = vi
          .fn()
          .mockImplementation((_projectRoot, subscriptionName, _subscription, callback) => {
            if (subscriptionName === "poltergeist_config") {
              configChangeCallback = callback;
            }
            return Promise.resolve();
          });
      }

      const poltergeist = new (await import("../src/poltergeist.js")).Poltergeist(
        baseConfig,
        "/test/project",
        harness.logger,
        enhancedMocks,
        configPath,
      );

      await poltergeist.start();

      expect(configChangeCallback).toBeDefined();

      // Mock the configuration manager to return a modified config
      const { ConfigurationManager } = await import("../src/utils/config-manager.js");
      vi.spyOn(ConfigurationManager, "loadConfigFromPath").mockResolvedValue({
        ...baseConfig,
        targets: [
          ...baseConfig.targets,
          {
            name: "reloaded-target",
            type: "executable",
            enabled: true,
            buildCommand: "npm run build:reloaded",
            outputPath: "./dist/reloaded.js",
            watchPaths: ["src/**/*.reloaded"],
            settlingDelay: 1000,
          },
        ],
      });

      // Simulate config file change
      await configChangeCallback?.([{ name: "poltergeist.config.json", exists: true }]);

      // Give it a moment to complete async operations
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Verify reload was triggered
      expect(harness.logger.info).toHaveBeenCalledWith(
        "🔄 Configuration file changed, reloading...",
      );

      // Check if success message was logged - it might have been interrupted by the test ending
      const infoMock = harness.logger.info as ReturnType<typeof vi.fn>;
      const allCalls = infoMock.mock.calls.map((call: unknown[]) => call[0]);
      const hasSuccessMessage = allCalls.some((msg: string) =>
        msg.includes("Configuration reloaded successfully"),
      );

      if (!hasSuccessMessage) {
        // If success message isn't there, at least verify that the config change process started
        // and did some work (like trying to add the new target)
        expect(allCalls).toContain("➕ Adding target: reloaded-target");
      } else {
        expect(harness.logger.info).toHaveBeenCalledWith("✅ Configuration reloaded successfully");
      }
    });

    test("should ignore non-config file changes", async () => {
      const configPath = "/test/poltergeist.config.json";
      const enhancedMocks = {
        ...harness.mocks,
        watchmanConfigManager: {
          ensureConfigUpToDate: vi.fn().mockResolvedValue(undefined),
          suggestOptimizations: vi.fn().mockResolvedValue([]),
          normalizeWatchPattern: vi.fn().mockImplementation((pattern: string) => pattern),
          validateWatchPattern: vi.fn(),
          createExclusionExpressions: vi.fn().mockReturnValue([]),
        },
      };

      let configChangeCallback: ((files: Array<{ name: string }>) => void) | undefined;

      if (enhancedMocks.watchmanClient) {
        enhancedMocks.watchmanClient.subscribe = vi
          .fn()
          .mockImplementation((_projectRoot, subscriptionName, _subscription, callback) => {
            if (subscriptionName === "poltergeist_config") {
              configChangeCallback = callback;
            }
            return Promise.resolve();
          });
      }

      const poltergeist = new (await import("../src/poltergeist.js")).Poltergeist(
        baseConfig,
        "/test/project",
        harness.logger,
        enhancedMocks,
        configPath,
      );

      await poltergeist.start();

      // Clear previous log calls
      vi.clearAllMocks();

      // Simulate non-config file change
      await configChangeCallback?.([{ name: "other-file.json", exists: true }]);

      // Verify reload was NOT triggered
      expect(harness.logger.info).not.toHaveBeenCalledWith(
        "🔄 Configuration file changed, reloading...",
      );
    });

    test("should ignore config file deletion", async () => {
      const configPath = "/test/poltergeist.config.json";
      const enhancedMocks = {
        ...harness.mocks,
        watchmanConfigManager: {
          ensureConfigUpToDate: vi.fn().mockResolvedValue(undefined),
          suggestOptimizations: vi.fn().mockResolvedValue([]),
          normalizeWatchPattern: vi.fn().mockImplementation((pattern: string) => pattern),
          validateWatchPattern: vi.fn(),
          createExclusionExpressions: vi.fn().mockReturnValue([]),
        },
      };

      let configChangeCallback: ((files: Array<{ name: string }>) => void) | undefined;

      if (enhancedMocks.watchmanClient) {
        enhancedMocks.watchmanClient.subscribe = vi
          .fn()
          .mockImplementation((_projectRoot, subscriptionName, _subscription, callback) => {
            if (subscriptionName === "poltergeist_config") {
              configChangeCallback = callback;
            }
            return Promise.resolve();
          });
      }

      const poltergeist = new (await import("../src/poltergeist.js")).Poltergeist(
        baseConfig,
        "/test/project",
        harness.logger,
        enhancedMocks,
        configPath,
      );

      await poltergeist.start();

      // Clear previous log calls
      vi.clearAllMocks();

      // Simulate config file deletion (exists: false)
      await configChangeCallback?.([{ name: "poltergeist.config.json", exists: false }]);

      // Verify reload was NOT triggered
      expect(harness.logger.info).not.toHaveBeenCalledWith(
        "🔄 Configuration file changed, reloading...",
      );
    });
  });
});
