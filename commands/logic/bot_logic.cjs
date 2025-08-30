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
} = require("../settings.cjs");
const {
  createRoleDropdown,
  requiredManagerPermissions,
  logErrorToChannel,
} = require("./helpers.cjs");

async function showBotSettingsUI(interactionOrMessage, isEphemeral = false) {
  try {
    const guild = interactionOrMessage.guild;
    if (!guild) {
      console.error("[ERROR] Guild is undefined in showBotSettingsUI");
      return;
    }

    // Permission check
    if (!(await requiredManagerPermissions(interactionOrMessage))) {
      const noPermissionMessage =
        "> <❇️> You do not have the required permissions to do this. (CMD_ERR_008)";
      if (interactionOrMessage instanceof Message) {
        await interactionOrMessage.channel.send(noPermissionMessage);
      } else {
        await interactionOrMessage.reply({
          content: noPermissionMessage,
          ephemeral: true,
        });
      }
      return;
    }

    // Retrieve settings; ensure we always have an object.
    let settings = (await getSettingsForGuild(guild.id)) || {};
    console.log(`[DEBUG] Loaded settings for guild ${guild.id}:`, settings);

    // camelCase / snake_case tolerance
    const adminRoleId = settings.adminRoleId || settings.admin_role_id || null;
    const moderatorRoleId =
      settings.moderatorRoleId || settings.moderator_role_id || null;

    console.log(
      `[DEBUG] adminRoleId: ${adminRoleId}, moderatorRoleId: ${moderatorRoleId}`
    );

    const adminRole = adminRoleId ? guild.roles.cache.get(adminRoleId) : null;
    const modRole = moderatorRoleId ? guild.roles.cache.get(moderatorRoleId) : null;

    console.log(
      `[DEBUG] Retrieved roles: Admin: ${adminRole ? adminRole.name : "Not set"}, Moderator: ${modRole ? modRole.name : "Not set"}`
    );

    const vcLoggingChannelId =
      settings.vcLoggingChannelId || settings.vc_logging_channel_id || null;
    const vcLoggingChannel = vcLoggingChannelId
      ? guild.channels.cache.get(vcLoggingChannelId)
      : null;

    const contentMessage = `## ◈ **Bot Settings**
> **Admin Role:** ${adminRole ? adminRole.name : "Not set"}
> **Moderator Role:** ${modRole ? modRole.name : "Not set"}
> **Notify for Activity Reports:** ${settings.notifyActivityReports ? "Enabled" : "Disabled"}
> **VC Event Logging Channel:** ${vcLoggingChannel ? vcLoggingChannel.name : "Not set"}
> **VC Event Logging:** ${settings.vcLoggingEnabled ? "Enabled" : "Disabled"}

-# *Unable to find a specific role? Log into the [Dashboard](<https://vctools.app/dashboard>) to avoid the 25 dropdown option limit.*`;

    const userId =
      interactionOrMessage.user?.id || interactionOrMessage.author?.id;

    // Role dropdowns (your helper builds these)
    const adminRoleDropdown = createRoleDropdown(
      `bot:select-admin-role:${userId}`,
      guild,
      userId,
      adminRoleId
    );
    const moderatorRoleDropdown = createRoleDropdown(
      `bot:select-moderator-role:${userId}`,
      guild,
      userId,
      moderatorRoleId
    );

    // Activity Reports toggle
    const toggleActivityNotificationsButton = new ButtonBuilder()
      .setCustomId(`bot:toggle-notify-activity-reports:${userId}`)
      .setLabel(
        settings.notifyActivityReports
          ? "Disable Notify for Activity Reports"
          : "Enable Notify for Activity Reports"
      )
      .setStyle(
        settings.notifyActivityReports ? ButtonStyle.Danger : ButtonStyle.Success
      );
    const toggleRow = new ActionRowBuilder().addComponents(
      toggleActivityNotificationsButton
    );

    // VC Logging toggle
    const toggleVcLoggingButton = new ButtonBuilder()
      .setCustomId(`bot:toggle-vc-logging:${userId}`)
      .setLabel(
        settings.vcLoggingEnabled ? "Disable VC Event Logging" : "Enable VC Event Logging"
      )
      .setStyle(settings.vcLoggingEnabled ? ButtonStyle.Danger : ButtonStyle.Success);
    const toggleVcLoggingRow = new ActionRowBuilder().addComponents(
      toggleVcLoggingButton
    );

    // ----- FIXED SECTION: build the channel select safely -----
    // Use builders for each option, slice to 25, and avoid setOptions().
    const textChannels = guild.channels.cache
      .filter((ch) => ch.type === ChannelType.GuildText)
      .map((ch) => ({
        id: String(ch.id),
        name: `#${String(ch.name ?? "").slice(0, 100)}`,
      }));

    const { StringSelectMenuOptionBuilder } = require("discord.js");

    const vcLoggingChannelOptionBuilders = textChannels
      .map(({ id, name }) =>
        new StringSelectMenuOptionBuilder()
          .setLabel(name)
          .setValue(id)
          .setDefault(String(id) === String(vcLoggingChannelId))
      )
      .slice(0, 25);

    let vcLoggingChannelRow;
    if (vcLoggingChannelOptionBuilders.length > 0) {
      const vcLoggingChannelDropdown = new StringSelectMenuBuilder()
        .setCustomId(`bot:select-vc-logging-channel:${userId}`)
        .setPlaceholder("Select a channel for VC Logging")
        .addOptions(vcLoggingChannelOptionBuilders)
        .setMinValues(1)
        .setMaxValues(1);

      vcLoggingChannelRow = new ActionRowBuilder().addComponents(
        vcLoggingChannelDropdown
      );
    } else {
      // Graceful empty state: disabled select with a single info option.
      const emptyOption = new StringSelectMenuOptionBuilder()
        .setLabel("No text channels available")
        .setValue("none")
        .setDefault(true);

      const disabledSelect = new StringSelectMenuBuilder()
        .setCustomId(`bot:select-vc-logging-channel:${userId}`)
        .setPlaceholder("No text channels available")
        .addOptions(emptyOption)
        .setMinValues(1)
        .setMaxValues(1)
        .setDisabled(true);

      vcLoggingChannelRow = new ActionRowBuilder().addComponents(disabledSelect);
    }
    // ----- END FIXED SECTION -----

    const components = [
      adminRoleDropdown,
      moderatorRoleDropdown,
      toggleRow,
      vcLoggingChannelRow,
      toggleVcLoggingRow,
    ];

    // Send or update
    if (interactionOrMessage.isRepliable?.()) {
      if (interactionOrMessage.replied || interactionOrMessage.deferred) {
        await interactionOrMessage.editReply({
          content: contentMessage,
          components,
        });
      } else {
        await interactionOrMessage.reply({
          content: contentMessage,
          components,
          ephemeral: isEphemeral,
        });
      }
    } else {
      await interactionOrMessage.channel.send({
        content: contentMessage,
        components,
      });
    }
  } catch (error) {
    console.error(`[ERROR] showBotSettingsUI failed: ${error.message}`);
    console.error(error.stack);
    await logErrorToChannel(
      interactionOrMessage.guild?.id,
      error.stack,
      interactionOrMessage.client,
      "showBotSettingsUI"
    );
    if (interactionOrMessage.isRepliable?.()) {
      if (interactionOrMessage.replied || interactionOrMessage.deferred) {
        await interactionOrMessage.editReply({
          content: "> <❌> An error occurred displaying Bot settings. (INT_ERR_006)",
        });
      } else {
        await interactionOrMessage.reply({
          content: "> <❌> An error occurred displaying Bot settings. (INT_ERR_006)",
          ephemeral: true,
        });
      }
    } else {
      await interactionOrMessage.channel.send(
        "> <❌> An error occurred displaying Bot settings. (INT_ERR_006)"
      );
    }
  }
}

module.exports = {
  showBotSettingsUI,
};
