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
const {
  showConsentSettingsUI,
  handleConsentSettingChange,
} = require("./consent_logic.cjs");
const { showErrorLogsSettingsUI } = require("./errorlogs_logic.cjs");

// ---------- helper: parse customId like "vcsettings:toggle-xyz:<userId>:..." ----------
function parseCustomId(customId = "") {
  const parts = String(customId).split(":");
  return {
    namespace: parts[0] || "",
    action: parts[1] || "",
    userId: parts[2] || "",
    raw: parts,
  };
}

async function handleSettingsFlow(interaction, mode, action) {
  try {
    const guild = interaction.guild;
    const userId = interaction.user?.id;
    if (!guild) return;

    // ---------- hard-stop router for VC components (single source of truth) ----------
    if (typeof interaction.isMessageComponent === "function" && interaction.isMessageComponent()) {
      const { namespace, action: parsedAction } = parseCustomId(interaction.customId);
      if (namespace === "vcsettings") {
        await handleVCSettingsFlow(interaction, parsedAction);
        return; // prevent any local UI from rendering a second menu
      }
    }

    // ---------- VC page open (slash/message forwarding) ----------
    if (mode === "vc") {
      await showVCSettingsUI(interaction, false);
      return;
    }

    // ---------- consent ----------
    if (mode === "consent") {
      await handleConsentSettingChange(interaction);
      return;
    }

    // ---------- prefix ----------
    if (mode === "prefix") {
      await handlePrefixSettingsFlow(interaction);
      return;
    }

    // ---------- transcription ----------
    if (action === "enable-transcription") {
      const currentSettings = await getSettingsForGuild(guild.id);
      await updateSettingsForGuild(guild.id, { ...currentSettings, transcriptionEnabled: true }, guild);
      await handleTranscriptionSettingChange(interaction);
      await showTranscriptionSettingsUI(interaction, false);
      return;
    }
    if (action === "disable-transcription") {
      const currentSettings = await getSettingsForGuild(guild.id);
      await updateSettingsForGuild(guild.id, { ...currentSettings, transcriptionEnabled: false }, guild);
      await handleTranscriptionSettingChange(interaction);
      await showTranscriptionSettingsUI(interaction, false);
      return;
    }
    if (action === "select-transcription-channel") {
      const selectedChannel = interaction.values?.[0];
      if (selectedChannel) {
        await updateSettingsForGuild(guild.id, { channelId: selectedChannel }, guild);
      }
      await handleTranscriptionSettingChange(interaction);
      await showTranscriptionSettingsUI(interaction, false);
      return;
    }
    if (action === "select-transcription-role") {
      const selectedRole = interaction.values?.[0];
      if (selectedRole) {
        await updateSettingsForGuild(guild.id, { allowedRoleId: selectedRole }, guild);
      }
      await handleTranscriptionSettingChange(interaction);
      await showTranscriptionSettingsUI(interaction, false);
      return;
    }

    // ---------- error logs ----------
    if (action === "enable-error-logging") {
      await updateSettingsForGuild(guild.id, { errorLogsEnabled: true }, guild);
      await showErrorLogsSettingsUI(interaction, false);
      return;
    }
    if (action === "disable-error-logging") {
      await updateSettingsForGuild(guild.id, { errorLogsEnabled: false }, guild);
      await showErrorLogsSettingsUI(interaction, false);
      return;
    }
    if (action === "select-errorlogs-channel" || action === "select_error_logs_channel") {
      const selectedChannel = interaction.values?.[0];
      if (selectedChannel) {
        await updateSettingsForGuild(guild.id, { errorLogsChannelId: selectedChannel }, guild);
      }
      await showErrorLogsSettingsUI(interaction, false);
      return;
    }
    if (action === "select-errorlogs-role" || action === "select_error_logs_role") {
      const selectedRole = interaction.values?.[0];
      if (selectedRole) {
        await updateSettingsForGuild(guild.id, { errorLogsRoleId: selectedRole }, guild);
      }
      await showErrorLogsSettingsUI(interaction, false);
      return;
    }

    // ---------- bot page (kept intact, not related to VC menu) ----------
    if (mode === "bot") {
      // helper to build VC logging controls for the bot page
      const defineVcLoggingComponents = (settingsObj) => {
        const vcLoggingChannelOptions = guild.channels.cache
          .filter((ch) => ch.type === ChannelType.GuildText)
          .map((ch) => ({
            label: `#${String(ch.name).slice(0, 100)}`,
            value: String(ch.id),
            default: ch.id === settingsObj.vcLoggingChannelId,
          }));
        const vcLoggingchannelIdropdown = new StringSelectMenuBuilder()
          .setCustomId(`bot:select-vc-logging-channel:${userId}`)
          .setPlaceholder("Select a channel for VC Event Logging")
          .setOptions(vcLoggingChannelOptions)
          .setMinValues(1)
          .setMaxValues(1);
        const vcLoggingChannelRow = new ActionRowBuilder().addComponents(
          vcLoggingchannelIdropdown
        );

        const toggleVcLoggingButton = new ButtonBuilder()
          .setCustomId(`bot:toggle-vc-logging:${userId}`)
          .setLabel(
            settingsObj.vcLoggingEnabled ? "Disable VC Event Logging" : "Enable VC Event Logging"
          )
          .setStyle(settingsObj.vcLoggingEnabled ? ButtonStyle.Danger : ButtonStyle.Success);
        const toggleVcLoggingRow = new ActionRowBuilder().addComponents(toggleVcLoggingButton);

        return { vcLoggingChannelRow, toggleVcLoggingRow };
      };

      if (action === "toggle-notify-activity-reports") {
        const settings = await getSettingsForGuild(guild.id);
        const newValue = !settings.notifyActivityReports;
        await updateSettingsForGuild(guild.id, { notifyActivityReports: newValue }, guild);

        const updatedSettings = await getSettingsForGuild(guild.id);
        const contentMessage = `## **◈ Bot Settings**
  > **Admin Role:** ${updatedSettings.adminRoleId
            ? guild.roles.cache.get(updatedSettings.adminRoleId)?.name || "Unknown Role"
            : "Not set"
          }
  > **Moderator Role:** ${updatedSettings.moderatorRoleId
            ? guild.roles.cache.get(updatedSettings.moderatorRoleId)?.name || "Unknown Role"
            : "Not set"
          }
  > **Notify for Activity Reports:** ${updatedSettings.notifyActivityReports ? "Enabled" : "Disabled"}

-# *Unable to find a specific role? Log into the [Dashboard](<https://vctools.app/dashboard>) to avoid the 25 dropdown option limit.*`;

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
          .setStyle(updatedSettings.notifyActivityReports ? ButtonStyle.Danger : ButtonStyle.Success);
        const toggleRow = new ActionRowBuilder().addComponents(toggleActivityNotificationsButton);

        const { vcLoggingChannelRow, toggleVcLoggingRow } = defineVcLoggingComponents(updatedSettings);

        const components = [
          adminRoleDropdown,
          moderatorRoleDropdown,
          toggleRow,
          toggleVcLoggingRow,
          vcLoggingChannelRow,
        ];

        await interaction.update({ content: contentMessage, components });
        await interaction.followUp({
          content: `> <✅> Notify for Activity Reports has been ${newValue ? "enabled" : "disabled"}.`,
          ephemeral: true,
        });
        return;
      }

      if (action === "select-admin-role") {
        const selectedRole = interaction.values?.[0];
        if (selectedRole) {
          await updateSettingsForGuild(guild.id, { adminRoleId: selectedRole }, guild);
        }
        const updatedSettings = await getSettingsForGuild(guild.id);
        const role = guild.roles.cache.get(updatedSettings.adminRoleId);
        const contentMessage = `## **◈ Bot Settings**
  > **Admin Role:** ${role ? role.name : "Not set"}
  > **Moderator Role:** ${updatedSettings.moderatorRoleId
            ? guild.roles.cache.get(updatedSettings.moderatorRoleId)?.name || "Unknown Role"
            : "Not set"
          }
  > **Notify for Activity Reports:** ${updatedSettings.notifyActivityReports ? "Enabled" : "Disabled"}

-# *Unable to find a specific role? Log into the [Dashboard](<https://vctools.app/dashboard>) to avoid the 25 dropdown option limit.*`;

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
          .setStyle(updatedSettings.notifyActivityReports ? ButtonStyle.Danger : ButtonStyle.Success);
        const toggleRow = new ActionRowBuilder().addComponents(toggleActivityNotificationsButton);
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
          content: `> <✅> Admin Role set to **${role ? role.name : "Unknown"}**.`,
          ephemeral: true,
        });
        return;
      }

      if (action === "select-moderator-role") {
        const selectedRole = interaction.values?.[0];
        if (selectedRole) {
          await updateSettingsForGuild(guild.id, { moderatorRoleId: selectedRole }, guild);
        }
        const updatedSettings = await getSettingsForGuild(guild.id);
        const role = guild.roles.cache.get(updatedSettings.moderatorRoleId);
        const contentMessage = `## **◈ Bot Settings**
  > **Admin Role:** ${updatedSettings.adminRoleId
            ? guild.roles.cache.get(updatedSettings.adminRoleId)?.name || "Unknown Role"
            : "Not set"
          }
  > **Moderator Role:** ${role ? role.name : "Not set"}
  > **Notify for Activity Reports:** ${updatedSettings.notifyActivityReports ? "Enabled" : "Disabled"}

-# *Unable to find a specific role? Log into the [Dashboard](<https://vctools.app/dashboard>) to avoid the 25 dropdown option limit.*`;

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
          .setStyle(updatedSettings.notifyActivityReports ? ButtonStyle.Danger : ButtonStyle.Success);
        const toggleRow = new ActionRowBuilder().addComponents(toggleActivityNotificationsButton);
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
          content: `> <✅> Moderator Role set to **${role ? role.name : "Unknown"}**.`,
          ephemeral: true,
        });
        return;
      }

      if (action === "toggle-vc-logging") {
        const currentSettings = await getSettingsForGuild(guild.id);
        const newValue = !currentSettings.vcLoggingEnabled;
        await updateSettingsForGuild(guild.id, { vcLoggingEnabled: newValue }, guild);
        await interaction.deferUpdate();
        await showBotSettingsUI(interaction, true);
        return;
      }

      if (action === "select-vc-logging-channel") {
        const selectedChannel = interaction.values?.[0];
        if (selectedChannel) {
          await updateSettingsForGuild(guild.id, { vcLoggingChannelId: selectedChannel }, guild);
        }
        await interaction.deferUpdate();
        await showBotSettingsUI(interaction, true);
        return;
      }

      await interaction.reply({
        content: "> <❌> Unrecognized action for Bot settings.",
        ephemeral: true,
      });
      return;
    }

    // ---------- fallback ----------
    await interaction.reply({
      content: "> <❌> Unrecognized settings action.",
      ephemeral: true,
    });
    return;
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
        // single source of truth
        await showVCSettingsUI(message, false);
        break;
      case "bot":
        await showBotSettingsUI(message, false);
        break;
      case "prefix":
        await showPrefixSettingsUI(message, false);
        break;
      case "consent":
        await showConsentSettingsUI(message, false);
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
                "> <❇️> That word is already in the filter."
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
      default:
        await message.channel.send(
          "> Use `settings transcription`, `settings errorlogs`, `settings vc`, `settings prefix`, `settings consent`, or `settings bot` to configure settings."
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
        // single source of truth
        await showVCSettingsUI(interaction, false);
        break;
      case "bot":
        await showBotSettingsUI(interaction, false);
        break;
      case "prefix":
        await showPrefixSettingsUI(interaction, false);
        break;
      case "consent":
        await showConsentSettingsUI(interaction, true);
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
                content: "> <❇️> That word is already in the filter.",
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
                content: `> <✅> Added **${word}** to the filter.`,
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
                content: "> <❇️> That word was not in the filter.",
                ephemeral: true,
              });
            } else {
              await updateSettingsForGuild(
                guild.id,
                { filterCustom: newCustom },
                guild
              );
              await interaction.reply({
                content: `> <✅> Removed **${word}** from the filter.`,
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
                content: "> <❇️> Level must be `moderate` or `strict`.",
                ephemeral: true,
              });
            } else {
              await updateSettingsForGuild(
                guild.id,
                { filterLevel: level },
                guild
              );
              await interaction.reply({
                content: `> <✅> Filter level set to **${level}**.`,
                ephemeral: false,
              });
            }
            break;
          }
          default:
            await interaction.reply({
              content: "> <❌> Unknown filter action. Use add|remove|list|level.",
              ephemeral: true,
            });
        }
        break;
      }
      default:
        await interaction.reply({
          content:
            "> <❌> Invalid settings category. Use `/settings transcription`, `settings prefix`, `/settings errorlogs`, `/settings vc`, `/settings consent`, or `/settings bot`.",
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