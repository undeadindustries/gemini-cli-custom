/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { modelCommand } from './modelCommand.js';
import { type CommandContext } from './types.js';
import { createMockCommandContext } from '../../test-utils/mockCommandContext.js';
import type { Config } from '@google/gemini-cli-core';
import { MessageType } from '../types.js';

describe('modelCommand', () => {
  let mockContext: CommandContext;

  beforeEach(() => {
    mockContext = createMockCommandContext();
  });

  it('should return a dialog action to open the model dialog when no args', async () => {
    if (!modelCommand.action) {
      throw new Error('The model command must have an action.');
    }

    const result = await modelCommand.action(mockContext, '');

    expect(result).toEqual({
      type: 'dialog',
      dialog: 'model',
    });
  });

  it('should call refreshUserQuota if config is available when opening dialog', async () => {
    if (!modelCommand.action) {
      throw new Error('The model command must have an action.');
    }

    const mockRefreshUserQuota = vi.fn();
    mockContext.services.agentContext = {
      refreshUserQuota: mockRefreshUserQuota,
      get config() {
        return this;
      },
    } as unknown as Config;

    await modelCommand.action(mockContext, '');

    expect(mockRefreshUserQuota).toHaveBeenCalled();
  });

  describe('manage subcommand', () => {
    it('should return a dialog action to open the model dialog', async () => {
      const manageCommand = modelCommand.subCommands?.find(
        (c) => c.name === 'manage',
      );
      expect(manageCommand).toBeDefined();

      const result = await manageCommand!.action!(mockContext, '');

      expect(result).toEqual({
        type: 'dialog',
        dialog: 'model',
      });
    });

    it('should call refreshUserQuota if config is available', async () => {
      const manageCommand = modelCommand.subCommands?.find(
        (c) => c.name === 'manage',
      );
      const mockRefreshUserQuota = vi.fn();
      mockContext.services.agentContext = {
        refreshUserQuota: mockRefreshUserQuota,
        get config() {
          return this;
        },
      } as unknown as Config;

      await manageCommand!.action!(mockContext, '');

      expect(mockRefreshUserQuota).toHaveBeenCalled();
    });
  });

  describe('set subcommand', () => {
    it('should set the model and log the command', async () => {
      const setCommand = modelCommand.subCommands?.find(
        (c) => c.name === 'set',
      );
      expect(setCommand).toBeDefined();

      const mockSetModel = vi.fn();
      mockContext.services.agentContext = {
        setModel: mockSetModel,
        getHasAccessToPreviewModel: vi.fn().mockReturnValue(true),
        getUserId: vi.fn().mockReturnValue('test-user'),
        getUsageStatisticsEnabled: vi.fn().mockReturnValue(true),
        getSessionId: vi.fn().mockReturnValue('test-session'),
        getContentGeneratorConfig: vi
          .fn()
          .mockReturnValue({ authType: 'test-auth' }),
        isInteractive: vi.fn().mockReturnValue(true),
        getExperiments: vi.fn().mockReturnValue({ experimentIds: [] }),
        getPolicyEngine: vi.fn().mockReturnValue({
          getApprovalMode: vi.fn().mockReturnValue('auto'),
        }),
        get config() {
          return this;
        },
      } as unknown as Config;

      await setCommand!.action!(mockContext, 'gemini-pro');

      expect(mockSetModel).toHaveBeenCalledWith('gemini-pro', true);
      expect(mockContext.ui.addItem).toHaveBeenCalledWith(
        expect.objectContaining({
          type: MessageType.INFO,
          text: expect.stringContaining('Model set to gemini-pro'),
        }),
      );
    });

    it('should set the model with persistence when --persist is used', async () => {
      const setCommand = modelCommand.subCommands?.find(
        (c) => c.name === 'set',
      );
      const mockSetModel = vi.fn();
      mockContext.services.agentContext = {
        setModel: mockSetModel,
        getHasAccessToPreviewModel: vi.fn().mockReturnValue(true),
        getUserId: vi.fn().mockReturnValue('test-user'),
        getUsageStatisticsEnabled: vi.fn().mockReturnValue(true),
        getSessionId: vi.fn().mockReturnValue('test-session'),
        getContentGeneratorConfig: vi
          .fn()
          .mockReturnValue({ authType: 'test-auth' }),
        isInteractive: vi.fn().mockReturnValue(true),
        getExperiments: vi.fn().mockReturnValue({ experimentIds: [] }),
        getPolicyEngine: vi.fn().mockReturnValue({
          getApprovalMode: vi.fn().mockReturnValue('auto'),
        }),
        get config() {
          return this;
        },
      } as unknown as Config;

      await setCommand!.action!(mockContext, 'gemini-pro --persist');

      expect(mockSetModel).toHaveBeenCalledWith('gemini-pro', false);
      expect(mockContext.ui.addItem).toHaveBeenCalledWith(
        expect.objectContaining({
          type: MessageType.INFO,
          text: expect.stringContaining('Model set to gemini-pro (persisted)'),
        }),
      );
    });

    it('should show error if no model name is provided', async () => {
      const setCommand = modelCommand.subCommands?.find(
        (c) => c.name === 'set',
      );
      await setCommand!.action!(mockContext, '');

      expect(mockContext.ui.addItem).toHaveBeenCalledWith(
        expect.objectContaining({
          type: MessageType.ERROR,
          text: expect.stringContaining('Usage: /model set <model-name>'),
        }),
      );
    });

    // --- LOCAL FORK ADDITION (Phase 2.4.6: route /model set through provider config) ---
    describe('openai-compat provider routing', () => {
      it('persists providers.<id>.model and refreshes generator on --persist for openai-chat', async () => {
        const setCommand = modelCommand.subCommands?.find(
          (c) => c.name === 'set',
        );
        const mockSetModel = vi.fn();
        const mockRefreshProviderConfig = vi.fn().mockResolvedValue(undefined);
        const mockGetActiveProviderId = vi
          .fn()
          .mockReturnValue('my-openrouter');
        const mockGetCustomProviders = vi.fn().mockReturnValue({
          'my-openrouter': {
            id: 'my-openrouter',
            displayName: 'OpenRouter',
            url: 'https://openrouter.ai/api/v1',
            wireFormat: 'openai-chat',
            requiresApiKey: false,
          },
        });
        mockContext.services.agentContext = {
          setModel: mockSetModel,
          refreshProviderConfig: mockRefreshProviderConfig,
          getActiveProviderId: mockGetActiveProviderId,
          getCustomProviders: mockGetCustomProviders,
          getHasAccessToPreviewModel: vi.fn().mockReturnValue(true),
          getUserId: vi.fn().mockReturnValue('test-user'),
          getUsageStatisticsEnabled: vi.fn().mockReturnValue(true),
          getSessionId: vi.fn().mockReturnValue('test-session'),
          getContentGeneratorConfig: vi
            .fn()
            .mockReturnValue({ authType: 'test-auth' }),
          isInteractive: vi.fn().mockReturnValue(true),
          getExperiments: vi.fn().mockReturnValue({ experimentIds: [] }),
          getPolicyEngine: vi.fn().mockReturnValue({
            getApprovalMode: vi.fn().mockReturnValue('auto'),
          }),
          get config() {
            return this;
          },
        } as unknown as Config;

        await setCommand!.action!(mockContext, 'openai/gpt-4o-mini --persist');

        expect(mockContext.services.settings.setValue).toHaveBeenCalledWith(
          'User',
          'providers.my-openrouter.model',
          'openai/gpt-4o-mini',
        );
        expect(mockRefreshProviderConfig).toHaveBeenCalledWith({
          setConfig: {
            id: 'my-openrouter',
            patch: { model: 'openai/gpt-4o-mini' },
          },
        });
        expect(mockSetModel).not.toHaveBeenCalled();
        expect(mockContext.ui.addItem).toHaveBeenCalledWith(
          expect.objectContaining({
            type: MessageType.INFO,
            text: expect.stringContaining('persisted to settings.json'),
          }),
        );
      });

      it('refreshes generator without persisting when --persist is omitted', async () => {
        const setCommand = modelCommand.subCommands?.find(
          (c) => c.name === 'set',
        );
        const mockRefreshProviderConfig = vi.fn().mockResolvedValue(undefined);
        mockContext.services.agentContext = {
          setModel: vi.fn(),
          refreshProviderConfig: mockRefreshProviderConfig,
          getActiveProviderId: vi.fn().mockReturnValue('my-openrouter'),
          getCustomProviders: vi.fn().mockReturnValue({
            'my-openrouter': {
              id: 'my-openrouter',
              displayName: 'OpenRouter',
              url: 'https://openrouter.ai/api/v1',
              wireFormat: 'openai-chat',
              requiresApiKey: false,
            },
          }),
          getHasAccessToPreviewModel: vi.fn().mockReturnValue(true),
          getUserId: vi.fn().mockReturnValue('test-user'),
          getUsageStatisticsEnabled: vi.fn().mockReturnValue(true),
          getSessionId: vi.fn().mockReturnValue('test-session'),
          getContentGeneratorConfig: vi
            .fn()
            .mockReturnValue({ authType: 'test-auth' }),
          isInteractive: vi.fn().mockReturnValue(true),
          getExperiments: vi.fn().mockReturnValue({ experimentIds: [] }),
          getPolicyEngine: vi.fn().mockReturnValue({
            getApprovalMode: vi.fn().mockReturnValue('auto'),
          }),
          get config() {
            return this;
          },
        } as unknown as Config;

        await setCommand!.action!(mockContext, 'openai/gpt-4o-mini');

        expect(mockContext.services.settings.setValue).not.toHaveBeenCalled();
        expect(mockRefreshProviderConfig).toHaveBeenCalled();
        expect(mockContext.ui.addItem).toHaveBeenCalledWith(
          expect.objectContaining({
            type: MessageType.INFO,
            text: expect.stringContaining('session only'),
          }),
        );
      });

      it('routes openai-responses providers through refreshProviderConfig', async () => {
        const setCommand = modelCommand.subCommands?.find(
          (c) => c.name === 'set',
        );
        const mockRefreshProviderConfig = vi.fn().mockResolvedValue(undefined);
        mockContext.services.agentContext = {
          setModel: vi.fn(),
          refreshProviderConfig: mockRefreshProviderConfig,
          getActiveProviderId: vi.fn().mockReturnValue('openai-responses'),
          getCustomProviders: vi.fn().mockReturnValue({}),
          getHasAccessToPreviewModel: vi.fn().mockReturnValue(true),
          getUserId: vi.fn().mockReturnValue('test-user'),
          getUsageStatisticsEnabled: vi.fn().mockReturnValue(true),
          getSessionId: vi.fn().mockReturnValue('test-session'),
          getContentGeneratorConfig: vi
            .fn()
            .mockReturnValue({ authType: 'test-auth' }),
          isInteractive: vi.fn().mockReturnValue(true),
          getExperiments: vi.fn().mockReturnValue({ experimentIds: [] }),
          getPolicyEngine: vi.fn().mockReturnValue({
            getApprovalMode: vi.fn().mockReturnValue('auto'),
          }),
          get config() {
            return this;
          },
        } as unknown as Config;

        await setCommand!.action!(mockContext, 'gpt-5-codex --persist');

        expect(mockRefreshProviderConfig).toHaveBeenCalledWith({
          setConfig: {
            id: 'openai-responses',
            patch: { model: 'gpt-5-codex' },
          },
        });
      });

      it('falls back to legacy config.setModel for gemini providers', async () => {
        const setCommand = modelCommand.subCommands?.find(
          (c) => c.name === 'set',
        );
        const mockSetModel = vi.fn();
        const mockRefreshProviderConfig = vi.fn();
        mockContext.services.agentContext = {
          setModel: mockSetModel,
          refreshProviderConfig: mockRefreshProviderConfig,
          // Gemini built-in id has wireFormat='gemini' in the registry,
          // so the openai-compat branch should not fire.
          getActiveProviderId: vi.fn().mockReturnValue('gemini-oauth'),
          getCustomProviders: vi.fn().mockReturnValue({}),
          getHasAccessToPreviewModel: vi.fn().mockReturnValue(true),
          getUserId: vi.fn().mockReturnValue('test-user'),
          getUsageStatisticsEnabled: vi.fn().mockReturnValue(true),
          getSessionId: vi.fn().mockReturnValue('test-session'),
          getContentGeneratorConfig: vi
            .fn()
            .mockReturnValue({ authType: 'test-auth' }),
          isInteractive: vi.fn().mockReturnValue(true),
          getExperiments: vi.fn().mockReturnValue({ experimentIds: [] }),
          getPolicyEngine: vi.fn().mockReturnValue({
            getApprovalMode: vi.fn().mockReturnValue('auto'),
          }),
          get config() {
            return this;
          },
        } as unknown as Config;

        await setCommand!.action!(mockContext, 'gemini-pro --persist');

        expect(mockSetModel).toHaveBeenCalledWith('gemini-pro', false);
        expect(mockRefreshProviderConfig).not.toHaveBeenCalled();
        expect(mockContext.services.settings.setValue).not.toHaveBeenCalled();
      });

      it('surfaces refreshProviderConfig errors as ERROR messages', async () => {
        const setCommand = modelCommand.subCommands?.find(
          (c) => c.name === 'set',
        );
        const mockRefreshProviderConfig = vi
          .fn()
          .mockRejectedValue(new Error('boom'));
        mockContext.services.agentContext = {
          setModel: vi.fn(),
          refreshProviderConfig: mockRefreshProviderConfig,
          getActiveProviderId: vi.fn().mockReturnValue('my-openrouter'),
          getCustomProviders: vi.fn().mockReturnValue({
            'my-openrouter': {
              id: 'my-openrouter',
              displayName: 'OpenRouter',
              url: 'https://openrouter.ai/api/v1',
              wireFormat: 'openai-chat',
              requiresApiKey: false,
            },
          }),
          get config() {
            return this;
          },
        } as unknown as Config;

        await setCommand!.action!(mockContext, 'openai/gpt-4o-mini');

        expect(mockContext.ui.addItem).toHaveBeenCalledWith(
          expect.objectContaining({
            type: MessageType.ERROR,
            text: expect.stringContaining('Failed to apply model change'),
          }),
        );
      });
    });
    // --- END LOCAL FORK ADDITION ---
  });

  it('should have the correct name and description', () => {
    expect(modelCommand.name).toBe('model');
    expect(modelCommand.description).toBe('Manage model configuration');
  });
});
