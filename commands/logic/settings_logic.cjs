const {
  Client,
  GatewayIntentBits,
  Partials,
  Collection,
  Events,
  Message,
  Interaction,
  PermissionsBitField,
  ChannelType,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  SlashCommandBuilder,
} = require("discord.js");

const { interactionContexts } = require("../../database/contextStore.cjs");

const {
  getSettingsForGuild,
  updateSettingsForGuild,
  updateChannelPermissionsForGuild,
  grantUserConsent,
  revokeUserConsent,
} = require("../settings.cjs");
const {
  createchannelIdropdown,
  createRoleDropdown,
  createErrorLogchannelIdropdown,
  createErrorLogRoleDropdown,
  logErrorToChannel,
} = require("./helpers.cjs");

const requiredManagerPermissions = ["ManageGuild"];

const { showVCSettingsUI, handleVCSettingsFlow } = require("./vc_logic.cjs");
const { showFilterSettingsUI } = require("./filter_logic.cjs");
const { showBotSettingsUI } = require("./bot_logic.cjs");
const {
  handleTranscriptionSettingChange,
  showTranscriptionSettingsUI,
} = require("./transcription_logic.cjs");
const {
  showPrefixSettingsUI,
  handlePrefixSettingsFlow,
} = require("./prefix_logic.cjs");
const { showErrorLogsSettingsUI } = require("./errorlogs_logic.cjs");

async function handleSettingsFlow(interaction, mode, action) {
  try {
    const guild = interaction.guild;
    const userId = interaction.user.id;
    if (!guild) return;

    // Delegate VC settings actions to handleVCSettingsFlow if mode is "vc" or "vcsettings"
    if (mode === "vc" || mode === "vcsettings") {
      await handleVCSettingsFlow(interaction, action);
      return;
    }

    // Prefix settings flow
    if (mode === "prefix") {
      return handlePrefixSettingsFlow(interaction);
    }

    let confirmation = "";
    let updatedUIFunction = null;

    // Helper: Define VC Logging components using current settings.
    // This creates both the vcLoggingChannelRow and the toggleVcLoggingRow.
    const defineVcLoggingComponents = (settingsObj) => {
      const vcLoggingChannelOptions = guild.channels.cache
        .filter((ch) => ch.type === ChannelType.GuildText)
        .map((ch) => ({
          label: `#${ch.name}`,
          value: ch.id,
          default: ch.id === settingsObj.vcLoggingChannelId,
        }));
      const vcLoggingchannelIdropdown = new StringSelectMenuBuilder()
        .setCustomId(`bot:select-vc-logging-channel:${userId}`)
        .setPlaceholder("Select a channel for VC Logging")
        .addOptions(vcLoggingChannelOptions);
      const vcLoggingChannelRow = new ActionRowBuilder().addComponents(
        vcLoggingchannelIdropdown
      );

      const toggleVcLoggingButton = new ButtonBuilder()
        .setCustomId(`bot:toggle-vc-logging:${userId}`)
        .setLabel(
          settingsObj.vcLoggingEnabled
            ? "Disable VC Event Logging"
            : "Enable VC Event Logging"
        )
        .setStyle(
          settingsObj.vcLoggingEnabled
            ? ButtonStyle.Danger
            : ButtonStyle.Success
        );
      const toggleVcLoggingRow = new ActionRowBuilder().addComponents(
        toggleVcLoggingButton
      );

      return { vcLoggingChannelRow, toggleVcLoggingRow };
    };

    // (Other branches remain the same...)
    // Transcription toggles
    // Transcription toggles (Fixed)
    if (action === "enable-transcription") {
      const currentSettings = getSettingsForGuild(guild.id);
      const updatedSettings = {
        ...currentSettings,
        transcriptionEnabled: true,
      };
      await updateSettingsForGuild(guild.id, updatedSettings, guild);
      confirmation = "Transcription has been enabled.";
      updatedUIFunction = showTranscriptionSettingsUI;
      await handleTranscriptionSettingChange(interaction);
    } else if (action === "disable-transcription") {
      const currentSettings = getSettingsForGuild(guild.id);
      const updatedSettings = {
        ...currentSettings,
        transcriptionEnabled: false,
      };
      await updateSettingsForGuild(guild.id, updatedSettings, guild);
      confirmation = "Transcription has been disabled.";
      updatedUIFunction = showTranscriptionSettingsUI;
      await handleTranscriptionSettingChange(interaction);
    }

    // Transcription dropdowns
    else if (action === "select-transcription-channel") {
      const selectedChannel = interaction.values[0];
      await updateSettingsForGuild(
        guild.id,
        { channelId: selectedChannel },
        guild
      );
      confirmation = "Transcription channel updated.";
      updatedUIFunction = showTranscriptionSettingsUI;
      await handleTranscriptionSettingChange(interaction);
    } else if (action === "select-transcription-role") {
      const selectedRole = interaction.values[0];
      await updateSettingsForGuild(
        guild.id,
        { allowedRoleId: selectedRole },
        guild
      );
      confirmation = "Transcription role updated.";
      updatedUIFunction = showTranscriptionSettingsUI;
      await handleTranscriptionSettingChange(interaction);
    }
    // Error logs toggles
    else if (action === "enable-error-logging") {
      await updateSettingsForGuild(guild.id, { errorLogsEnabled: true }, guild);
      confirmation = "Error logging has been enabled.";
      updatedUIFunction = showErrorLogsSettingsUI;
    } else if (action === "disable-error-logging") {
      await updateSettingsForGuild(
        guild.id,
        { errorLogsEnabled: false },
        guild
      );
      confirmation = "Error logging has been disabled.";
      updatedUIFunction = showErrorLogsSettingsUI;
    }
    // Error logs dropdowns
    else if (
      action === "select-errorlogs-channel" ||
      action === "select_error_logs_channel"
    ) {
      const selectedChannel = interaction.values[0];
      await updateSettingsForGuild(
        guild.id,
        { errorLogsChannelId: selectedChannel },
        guild
      );
      confirmation = "Error logs channel updated.";
      updatedUIFunction = showErrorLogsSettingsUI;
    } else if (
      action === "select-errorlogs-role" ||
      action === "select_error_logs_role"
    ) {
      const selectedRole = interaction.values[0];
      await updateSettingsForGuild(
        guild.id,
        { errorLogsRoleId: selectedRole },
        guild
      );
      confirmation = "Error logs role updated.";
      updatedUIFunction = showErrorLogsSettingsUI;
    }
    // Bot-specific settings: select-admin-role
    else if (mode === "bot" && action === "select-admin-role") {
      const selectedRole = interaction.values[0];
      await updateSettingsForGuild(
        guild.id,
        { adminRoleId: selectedRole },
        guild
      );

      // Re-fetch updated settings to ensure fresh data
      const updatedSettings = await getSettingsForGuild(guild.id);
      const role = guild.roles.cache.get(updatedSettings.adminRoleId);

      await interaction.deferUpdate();
      await interaction.followUp({
        content: `> <✅> Admin Role set to **${role ? role.name : "Unknown"
          }**.`,
        ephemeral: true,
      });

      // Refresh the full UI with updated settings
      await showBotSettingsUI(interaction, true);
      return;
    }
    // Inline UI update for bot mode
    else if (mode === "bot") {
      if (action === "toggle-notify-activity-reports") {
        const settings = await getSettingsForGuild(guild.id);
        const newValue = !settings.notifyActivityReports;
        await updateSettingsForGuild(
          guild.id,
          { notifyActivityReports: newValue },
          guild
        );

        const updatedSettings = await getSettingsForGuild(guild.id);
        const contentMessage = `## **Bot Settings**
  > **Admin Role:** ${updatedSettings.adminRoleId
            ? guild.roles.cache.get(updatedSettings.adminRoleId)?.name ||
            "Unknown Role"
            : "Not set"
          }
  > **Moderator Role:** ${updatedSettings.moderatorRoleId
            ? guild.roles.cache.get(updatedSettings.moderatorRoleId)?.name ||
            "Unknown Role"
            : "Not set"
          }
  > **Notify for Activity Reports:** ${updatedSettings.notifyActivityReports ? "Enabled" : "Disabled"
          }`;

        const adminRoleDropdown = createRoleDropdown(
          `bot:select-admin-role:${userId}`,
          guild,
          userId,
          updatedSettings.adminRoleId
        );
        const moderatorRoleDropdown = createRoleDropdown(
          `bot:select-moderator-role:${userId}`,
          guild,
          userId,
          updatedSettings.moderatorRoleId
        );
        const toggleActivityNotificationsButton = new ButtonBuilder()
          .setCustomId(`bot:toggle-notify-activity-reports:${userId}`)
          .setLabel(
            updatedSettings.notifyActivityReports
              ? "Disable Notify for Activity Reports"
              : "Enable Notify for Activity Reports"
          )
          .setStyle(
            updatedSettings.notifyActivityReports
              ? ButtonStyle.Danger
              : ButtonStyle.Success
          );
        const toggleRow = new ActionRowBuilder().addComponents(
          toggleActivityNotificationsButton
        );

        // Get VC Logging components using the helper
        const { vcLoggingChannelRow, toggleVcLoggingRow } =
          defineVcLoggingComponents(updatedSettings);

        const components = [
          adminRoleDropdown,
          moderatorRoleDropdown,
          toggleRow,
          toggleVcLoggingRow,
          vcLoggingChannelRow,
        ];

        await interaction.update({ content: contentMessage, components });
        await interaction.followUp({
          content: `> <✅> Notify for Activity Reports has been ${newValue ? "enabled" : "disabled"
            }.`,
          ephemeral: true,
        });
        return;
      } else if (action === "select-admin-role") {
        const selectedRole = interaction.values[0];
        await updateSettingsForGuild(
          guild.id,
          { adminRoleId: selectedRole },
          guild
        );
        const updatedSettings = await getSettingsForGuild(guild.id);
        const role = guild.roles.cache.get(updatedSettings.adminRoleId);
        const contentMessage = `## **Bot Settings**
  > **Admin Role:** ${role ? role.name : "Not set"}
  > **Moderator Role:** ${updatedSettings.moderatorRoleId
            ? guild.roles.cache.get(updatedSettings.moderatorRoleId)?.name ||
            "Unknown Role"
            : "Not set"
          }
  > **Notify for Activity Reports:** ${updatedSettings.notifyActivityReports ? "Enabled" : "Disabled"
          }`;
        const adminRoleDropdown = createRoleDropdown(
          `bot:select-admin-role:${userId}`,
          guild,
          userId,
          updatedSettings.adminRoleId
        );
        const moderatorRoleDropdown = createRoleDropdown(
          `bot:select-moderator-role:${userId}`,
          guild,
          userId,
          updatedSettings.moderatorRoleId
        );
        const toggleActivityNotificationsButton = new ButtonBuilder()
          .setCustomId(`bot:toggle-notify-activity-reports:${userId}`)
          .setLabel(
            updatedSettings.notifyActivityReports
              ? "Disable Notify for Activity Reports"
              : "Enable Notify for Activity Reports"
          )
          .setStyle(
            updatedSettings.notifyActivityReports
              ? ButtonStyle.Danger
              : ButtonStyle.Success
          );
        const toggleRow = new ActionRowBuilder().addComponents(
          toggleActivityNotificationsButton
        );
        const { vcLoggingChannelRow, toggleVcLoggingRow } =
          defineVcLoggingComponents(updatedSettings);
        const components = [
          adminRoleDropdown,
          moderatorRoleDropdown,
          toggleRow,
          toggleVcLoggingRow,
          vcLoggingChannelRow,
        ];

        await interaction.update({ content: contentMessage, components });
        await interaction.followUp({
          content: `> <✅> Admin Role set to **${role ? role.name : "Unknown"
            }**.`,
          ephemeral: true,
        });
        return;
      } else if (action === "select-moderator-role") {
        const selectedRole = interaction.values[0];
        await updateSettingsForGuild(
          guild.id,
          { moderatorRoleId: selectedRole },
          guild
        );
        const updatedSettings = await getSettingsForGuild(guild.id);
        const role = guild.roles.cache.get(updatedSettings.moderatorRoleId);
        const contentMessage = `## **Bot Settings**
  > **Admin Role:** ${updatedSettings.adminRoleId
            ? guild.roles.cache.get(updatedSettings.adminRoleId)?.name ||
            "Unknown Role"
            : "Not set"
          }
  > **Moderator Role:** ${role ? role.name : "Not set"}
  > **Notify for Activity Reports:** ${updatedSettings.notifyActivityReports ? "Enabled" : "Disabled"
          }`;
        const adminRoleDropdown = createRoleDropdown(
          `bot:select-admin-role:${userId}`,
          guild,
          userId,
          updatedSettings.adminRoleId
        );
        const moderatorRoleDropdown = createRoleDropdown(
          `bot:select-moderator-role:${userId}`,
          guild,
          userId,
          updatedSettings.moderatorRoleId
        );
        const toggleActivityNotificationsButton = new ButtonBuilder()
          .setCustomId(`bot:toggle-notify-activity-reports:${userId}`)
          .setLabel(
            updatedSettings.notifyActivityReports
              ? "Disable Notify for Activity Reports"
              : "Enable Notify for Activity Reports"
          )
          .setStyle(
            updatedSettings.notifyActivityReports
              ? ButtonStyle.Danger
              : ButtonStyle.Success
          );
        const toggleRow = new ActionRowBuilder().addComponents(
          toggleActivityNotificationsButton
        );
        const { vcLoggingChannelRow, toggleVcLoggingRow } =
          defineVcLoggingComponents(updatedSettings);
        const components = [
          adminRoleDropdown,
          moderatorRoleDropdown,
          toggleRow,
          toggleVcLoggingRow,
          vcLoggingChannelRow,
        ];

        await interaction.update({ content: contentMessage, components });
        await interaction.followUp({
          content: `> <✅> Moderator Role set to **${role ? role.name : "Unknown"
            }**.`,
          ephemeral: true,
        });
        return;
      } else if (mode === "bot" && action === "toggle-vc-logging") {
        const currentSettings = getSettingsForGuild(guild.id);
        const newValue = !currentSettings.vcLoggingEnabled;
        await updateSettingsForGuild(
          guild.id,
          { vcLoggingEnabled: newValue },
          guild
        );
        await interaction.deferUpdate();
        await showBotSettingsUI(interaction, true);
        return;
      }
      // VC Logging channel selection branch:
      else if (mode === "bot" && action === "select-vc-logging-channel") {
        const selectedChannel = interaction.values[0];
        await updateSettingsForGuild(
          guild.id,
          { vcLoggingChannelId: selectedChannel },
          guild
        );
        await interaction.deferUpdate();
        await showBotSettingsUI(interaction, true);
        return;
      } else {
        await interaction.reply({
          content: "> <❌> Unrecognized action for Bot settings.",
          ephemeral: true,
        });
        return;
      }
    } else {
      await interaction.reply({
        content: "> <❌> Unrecognized settings action.",
        ephemeral: true,
      });
      return;
    }

    // For actions handled by updatedUIFunction (full-page refresh)
    if (updatedUIFunction) {
      await updatedUIFunction(interaction, false);
    }
  } catch (error) {
    console.error(`[ERROR] handleSettingsFlow failed: ${error.message}`);
    await logErrorToChannel(
      interaction.guild?.id,
      error.stack,
      interaction.client,
      "handleSettingsFlow"
    );
    if (!interaction.replied) {
      await interaction.reply({
        content:
          "> <❌> An error occurred processing your interaction. (INT_ERR_006)",
        ephemeral: true,
      });
    }
  }
}

async function handleSettingsMessageCommand(message, args) {
  try {
    if (!message.member.permissions.has(requiredManagerPermissions)) {
      await message.channel.send(
        "> <❌> You do not have the required permissions."
      );
      return;
    }
    interactionContexts.set(message.author.id, {
      guildId: message.guild.id,
      mode: "settings",
    });
    const guild = message.guild;
    const subCommand = args[0]?.toLowerCase() || "help";
    const settings = await getSettingsForGuild(guild.id);
    switch (subCommand) {
      case "transcription":
        await showTranscriptionSettingsUI(message, false);
        break;
      case "errorlogs":
        await showErrorLogsSettingsUI(message, false);
        break;
      case "vc":
        await showVCSettingsUI(message, false);
        break;
      case "bot":
        await showBotSettingsUI(message, false);
        break;
      case "prefix":
        await showPrefixSettingsUI(message, false);
        break;
      case "toggle":
        if (!args[1]) {
          return message.channel.send(
            "> <❌> Missing option. Use `transcription`, `errorlogs`, `vc-notify-badwords`, or `vc-notify-loud`."
          );
        }
        let update = {};
        let toggleMessage = "";
        switch (args[1]) {
          case "transcription":
            update.transcriptionEnabled = !settings.transcriptionEnabled;
            toggleMessage = `> <✅> Transcription has been **${update.transcriptionEnabled ? "enabled" : "disabled"
              }**.`;
            break;
          case "errorlogs":
            update.errorLogsEnabled = !settings.errorLogsEnabled;
            toggleMessage = `> <✅> Error logging has been **${update.errorLogsEnabled ? "enabled" : "disabled"
              }**.`;
            break;
          case "vc-notify-badwords":
            update.notifyBadWord = !settings.notifyBadWord;
            toggleMessage = `> <✅> VC bad words notification has been **${update.notifyBadWord ? "enabled" : "disabled"
              }**.`;
            break;
          case "vc-notify-loud":
            update.notifyLoudUser = !settings.notifyLoudUser;
            toggleMessage = `> <✅> Loud user detection has been **${update.notifyLoudUser ? "enabled" : "disabled"
              }**.`;
            break;
          default:
            return message.channel.send(
              "> <❌> Invalid toggle option. Use `transcription`, `errorlogs`, `vc-notify-badwords`, or `vc-notify-loud`."
            );
        }
        await updateSettingsForGuild(guild.id, update, guild);
        await message.channel.send(toggleMessage);
        break;
      case "filter":
        // Filter handling remains unchanged.
        if (!args[1]) {
          await showFilterSettingsUI(message, false);
          break;
        }
        const filterAction = args[1].toLowerCase();
        const guildId = message.guild.id;
        const currentCustom = settings.filterCustom || [];
        switch (filterAction) {
          case "add": {
            if (!args[2]) {
              return message.channel.send(
                "> <❌> Usage: `settings filter add <word>`"
              );
            }
            const wordToAdd = args[2].toLowerCase();
            if (currentCustom.includes(wordToAdd)) {
              return message.channel.send(
                "> That word is already in the filter."
              );
            }
            currentCustom.push(wordToAdd);
            await updateSettingsForGuild(
              guildId,
              { filterCustom: currentCustom },
              message.guild
            );
            message.channel.send(
              `> <✅> Added **${wordToAdd}** to the filter.`
            );
            break;
          }
          case "remove": {
            if (!args[2]) {
              return message.channel.send(
                "> <❌> Usage: `settings filter remove <word>`"
              );
            }
            const wordToRemove = args[2].toLowerCase();
            const newCustom = currentCustom.filter((w) => w !== wordToRemove);
            if (newCustom.length === currentCustom.length) {
              return message.channel.send(
                "> <❌> That word was not in the filter."
              );
            }
            await updateSettingsForGuild(
              guildId,
              { filterCustom: newCustom },
              message.guild
            );
            message.channel.send(
              `> <✅> Removed **${wordToRemove}** from the filter.`
            );
            break;
          }
          case "list": {
            if (currentCustom.length === 0) {
              message.channel.send("> **No custom filter words set.**");
            } else {
              message.channel.send(
                `> **Custom Filter Words:** ${currentCustom.join(", ")}`
              );
            }
            break;
          }
          case "level": {
            if (
              !args[2] ||
              !["moderate", "strict"].includes(args[2].toLowerCase())
            ) {
              return message.channel.send(
                "> <❌> Usage: `settings filter level <moderate|strict>`"
              );
            }
            const newLevel = args[2].toLowerCase();
            await updateSettingsForGuild(
              guildId,
              { filterLevel: newLevel },
              message.guild
            );
            message.channel.send(`> <✅> Filter level set to **${newLevel}**.`);
            break;
          }
          default:
            message.channel.send(
              "> <❌> Unknown filter subcommand. Use add|remove|list|level."
            );
        }
        break;
      case "set-channel": {
        if (!args[1] || !args[2]) {
          return message.channel.send(
            "> <❌> Usage: `settings set-channel <transcription|errorlogs> #channel`"
          );
        }
        const channelMention = args[2];
        const channelId = channelMention?.replace(/[<#>]/g, "");
        const channel = guild.channels.cache.get(channelId);
        if (!channel || channel.type !== ChannelType.GuildText) {
          return message.channel.send(
            "> <❌> Please mention a valid text channel."
          );
        }
        let channelUpdate = {};
        let settingLabel = "";
        let roleId = null;
        switch (args[1]) {
          case "transcription":
            channelUpdate.channelId = channel.id;
            settingLabel = "Transcription logs";
            roleId = settings.allowedRoleId;
            break;
          case "errorlogs":
            channelUpdate.errorLogsChannelId = channel.id;
            settingLabel = "Error logs";
            roleId = settings.errorLogsRoleId;
            break;
          default:
            return message.channel.send(
              "> <❌> Invalid channel setting. Use `transcription` or `errorlogs`."
            );
        }
        await updateSettingsForGuild(guild.id, channelUpdate, guild);
        await updateChannelPermissionsForGuild(
          guild.id,
          channel.id,
          roleId,
          guild
        );
        await message.channel.send(
          `> <✅> ${settingLabel} channel set to <#${channel.id}>.`
        );
        break;
      }
      case "set-role": {
        if (!args[1] || !args[2]) {
          return message.channel.send(
            "> <❌> Usage: `settings set-role <transcription|errorlogs|vc|admin|moderator> @role`"
          );
        }
        const roleMention = args[2];
        const roleId = roleMention?.replace(/[<@&>]/g, "");
        const role = guild.roles.cache.get(roleId);
        if (!role) {
          return message.channel.send("> <❌> Please mention a valid role.");
        }
        let roleUpdate = {};
        let roleSettingLabel = "";
        switch (args[1]) {
          case "transcription":
            roleUpdate.allowedRoleId = role.id;
            roleSettingLabel = "Transcription logs";
            break;
          case "errorlogs":
            roleUpdate.errorLogsRoleId = role.id;
            roleSettingLabel = "Error logs";
            break;
          case "vc":
            roleUpdate.voiceCallPingRoleId = role.id;
            roleSettingLabel = "VC Ping";
            break;
          case "admin":
            roleUpdate.adminRoleId = role.id;
            roleSettingLabel = "Admin";
            break;
          case "moderator":
            roleUpdate.moderatorRoleId = role.id;
            roleSettingLabel = "Moderator";
            break;
          default:
            return message.channel.send(
              "> <❌> Invalid role setting. Use `transcription`, `errorlogs`, `vc`, `admin`, or `moderator`."
            );
        }
        await updateSettingsForGuild(guild.id, roleUpdate, guild);
        await message.channel.send(
          `> <✅> ${roleSettingLabel} role set to **${role.name}**.`
        );
        break;
      }
      default:
        await message.channel.send(
          "> Use `settings transcription`, `settings errorlogs`, `settings vc`, `settings prefix`, or `settings bot` to configure settings."
        );
    }
  } catch (error) {
    console.error(
      `[ERROR] handleSettingsMessageCommand failed: ${error.message}`
    );
    await logErrorToChannel(
      message.guild?.id,
      error.stack,
      message.client,
      "handleSettingsMessageCommand"
    );
    await message.channel.send(
      "> <❌> An error occurred processing the settings command. (INT_ERR_006)"
    );
  }
}

async function handleSettingsSlashCommand(interaction) {
  try {
    if (!interaction.guild) {
      await interaction.reply(
        "> <🔒> This command can only be used in a server."
      );
      return;
    }
    if (!interaction.memberPermissions.has(requiredManagerPermissions)) {
      await interaction.reply({
        content:
          "> <❌> You do not have the required permissions. (CMD_ERR_008)",
        ephemeral: true,
      });
      return;
    }
    interactionContexts.set(interaction.user.id, {
      guildId: interaction.guild.id,
      mode: "settings",
    });
    let subCommandName;
    try {
      subCommandName = interaction.options.getSubcommand(false) || "help";
    } catch {
      subCommandName = "help";
    }
    switch (subCommandName) {
      case "transcription":
        await showTranscriptionSettingsUI(interaction, false);
        break;
      case "errorlogs":
        await showErrorLogsSettingsUI(interaction, false);
        break;
      case "vc":
        await showVCSettingsUI(interaction, false);
        break;
      case "bot":
        await showBotSettingsUI(interaction, false);
        break;
      case "prefix":
        await showPrefixSettingsUI(interaction, false);
        break;
      case "toggle": {
        const option = interaction.options.getString("option");
        const guild = interaction.guild;
        const settings = await getSettingsForGuild(guild.id);
        let update = {};
        let replyMessage = "";
        if (option === "transcription") {
          update.transcriptionEnabled = !settings.transcriptionEnabled;
          replyMessage = `> <✅> Transcription has been **${update.transcriptionEnabled ? "enabled" : "disabled"
            }**.`;
        } else if (option === "errorlogs") {
          update.errorLogsEnabled = !settings.errorLogsEnabled;
          replyMessage = `> <✅> Error logging has been **${update.errorLogsEnabled ? "enabled" : "disabled"
            }**.`;
        } else if (option === "vc-notify-badwords") {
          update.notifyBadWord = !settings.notifyBadWord;
          replyMessage = `> <✅> VC bad words notification has been **${update.notifyBadWord ? "enabled" : "disabled"
            }**.`;
        } else if (option === "vc-notify-loud") {
          update.notifyLoudUser = !settings.notifyLoudUser;
          replyMessage = `> <✅> Loud user detection has been **${update.notifyLoudUser ? "enabled" : "disabled"
            }**.`;
        }
        if (replyMessage) {
          await updateSettingsForGuild(guild.id, update, guild);
          await interaction.reply(replyMessage);
        } else {
          await interaction.reply({
            content: "> <❌> Unknown toggle option.",
            ephemeral: true,
          });
        }
        break;
      }
      case "set-channel": {
        const channel = interaction.options.getChannel("channel");
        if (!channel || channel.type !== ChannelType.GuildText) {
          await interaction.reply("> <❌> Please select a valid text channel.");
          return;
        }
        const guild = interaction.guild;
        if (!guild) {
          await interaction.reply({
            content: "> <❌> Guild information is missing.",
            ephemeral: true,
          });
          return;
        }
        await updateSettingsForGuild(
          guild.id,
          { channelId: channel.id },
          guild
        );
        const settings = await getSettingsForGuild(guild.id);
        await updateChannelPermissionsForGuild(
          guild.id,
          channel.id,
          settings.allowedRoleId,
          guild
        );
        await interaction.reply(
          `> <✅> Transcription logs channel set to <#${channel.id}>.`
        );
        break;
      }
      case "set-role": {
        const role = interaction.options.getRole("role");
        const type = interaction.options.getString("type");
        if (!role) {
          await interaction.reply({
            content: "> <❌> Please select a valid role.",
            ephemeral: true,
          });
          return;
        }
        let update = {};
        let roleLabel = "";
        switch (type) {
          case "transcription":
            update.allowedRoleId = role.id;
            roleLabel = "Transcription logs";
            break;
          case "errorlogs":
            update.errorLogsRoleId = role.id;
            roleLabel = "Error logs";
            break;
          case "vc":
            update.voiceCallPingRoleId = role.id;
            roleLabel = "VC Ping";
            break;
          case "admin":
            update.adminRoleId = role.id;
            roleLabel = "Admin";
            break;
          case "moderator":
            update.moderatorRoleId = role.id;
            roleLabel = "Moderator";
            break;
          default:
            await interaction.reply({
              content: "> <❌> Invalid role type.",
              ephemeral: true,
            });
            return;
        }
        await updateSettingsForGuild(
          interaction.guild.id,
          update,
          interaction.guild
        );
        await showBotSettingsUI(interaction, false);
        await interaction.followUp({
          content: `> <✅> ${roleLabel} role set to **${role.name}**.`,
          ephemeral: true,
        });
        break;
      }
      case "filter": {
        const actionOption = interaction.options.getString("action", true);
        const guild = interaction.guild;
        const settings = await getSettingsForGuild(guild.id);
        const currentCustom = settings.filterCustom || [];
        switch (actionOption.toLowerCase()) {
          case "list": {
            const listText = currentCustom.length
              ? currentCustom.join(", ")
              : "None";
            await interaction.reply({
              content: `**Custom Filter Words:** ${listText}`,
              ephemeral: false,
            });
            break;
          }
          case "add": {
            const word = interaction.options
              .getString("word", true)
              .toLowerCase();
            if (currentCustom.includes(word)) {
              await interaction.reply({
                content: "That word is already in the filter.",
                ephemeral: true,
              });
            } else {
              currentCustom.push(word);
              await updateSettingsForGuild(
                guild.id,
                { filterCustom: currentCustom },
                guild
              );
              await interaction.reply({
                content: `Added **${word}** to the filter.`,
                ephemeral: false,
              });
            }
            break;
          }
          case "remove": {
            const word = interaction.options
              .getString("word", true)
              .toLowerCase();
            const newCustom = currentCustom.filter((w) => w !== word);
            if (newCustom.length === currentCustom.length) {
              await interaction.reply({
                content: "That word was not in the filter.",
                ephemeral: true,
              });
            } else {
              await updateSettingsForGuild(
                guild.id,
                { filterCustom: newCustom },
                guild
              );
              await interaction.reply({
                content: `Removed **${word}** from the filter.`,
                ephemeral: false,
              });
            }
            break;
          }
          case "level": {
            const level = interaction.options
              .getString("level", true)
              .toLowerCase();
            if (!["moderate", "strict"].includes(level)) {
              await interaction.reply({
                content: "Level must be `moderate` or `strict`.",
                ephemeral: true,
              });
            } else {
              await updateSettingsForGuild(
                guild.id,
                { filterLevel: level },
                guild
              );
              await interaction.reply({
                content: `Filter level set to **${level}**.`,
                ephemeral: false,
              });
            }
            break;
          }
          default:
            await interaction.reply({
              content: "Unknown filter action. Use add|remove|list|level.",
              ephemeral: true,
            });
        }
        break;
      }
      default:
        await interaction.reply({
          content:
            "> <❌> Invalid settings category. Use `/settings transcription`, `settings prefix`, `/settings errorlogs`, `/settings vc`, or `/settings bot`.",
          ephemeral: true,
        });
    }
  } catch (error) {
    console.error(
      `[ERROR] handleSettingsSlashCommand failed: ${error.message}`
    );
    await logErrorToChannel(
      interaction.guild?.id,
      error.stack,
      interaction.client,
      "handleSettingsSlashCommand"
    );
    if (!interaction.replied) {
      await interaction.reply({
        content:
          "> <❌> An error occurred processing the settings command. (INT_ERR_006)",
        ephemeral: true,
      });
    }
  }
}

module.exports = {
  handleSettingsFlow,
  handleSettingsMessageCommand,
  handleSettingsSlashCommand,
};
