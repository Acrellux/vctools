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

const { handleInitializeFTT } = require("../initialization/ftt.cjs");
const {
  handleInitializeErrorLogs,
  handleErrorLogsFlow,
} = require("../initialization/errorlogs.cjs");
const {
  handleInitializeTranscription,
  handleTranscriptionFlow,
} = require("../initialization/transcription.cjs");
const {
  handleInitializeStaffRoles,
  handleStaffRolesFlow,
} = require("../initialization/staffRoles.cjs");

const {
  logErrorToChannel,
  createchannelIdropdown,
  createErrorLogchannelIdropdown,
  createRoleDropdown,
  createErrorLogRoleDropdown,
} = require("./helpers.cjs");

const { requiredManagerPermissions } = require("./helpers.cjs");

const { updateSettingsForGuild, getSettingsForGuild } = require("../settings.cjs");

/* =============================
     INITIALIZATION COMMAND HANDLERS
  ============================= */

async function handleInitializeMessageCommand(message, args) {
  try {
    if (!message.guild) {
      await message.channel.send(
        "> <🔒> This command can only be used in a server."
      );
      return;
    }
    if (!(await requiredManagerPermissions(message))) {
      await message.channel.send(
        "> <❇️> You must be an admin to initialize VC Tools. (CMD_ERR_008)"
      );
      return;
    }

    const method = args[0]?.toLowerCase();
    if (
      !method ||
      !["ftt", "errorlogs", "transcription", "staffroles"].includes(method)
    ) {
      await message.channel.send(
        "> <❌> Invalid method. Use `ftt`, `errorlogs`, `staffroles`, or `transcription`."
      );
      return;
    }

    const userId = message.author.id;
    const guild = message.guild;

    interactionContexts.set(userId, {
      guildId: guild.id,
      mode: "init",
      initMethod: method,
    });

    console.log(
      `[DEBUG] handleInitializeMessageCommand: method=${method}, userId=${userId}`
    );

    switch (method) {
      case "ftt":
        await handleInitializeFTT(message);
        break;
      case "errorlogs":
        await handleInitializeErrorLogs(message);
        break;
      case "transcription":
        await handleInitializeTranscription(message);
        break;
      case "staffroles":
        await handleInitializeStaffRoles(message);
        break;
    }
  } catch (error) {
    console.error(
      `[ERROR] handleInitializeMessageCommand failed: ${error.message}`
    );
    await logErrorToChannel(
      message.guild?.id,
      error.stack,
      message.client,
      "handleInitializeMessageCommand"
    );
    await message.channel.send(
      "> <❌> An error occurred processing the initialize command. (INT_ERR_006)"
    );
  }
}

async function handleInitializeSlashCommand(interaction) {
  try {
    if (!interaction.guild) {
      await interaction.reply({
        content: "> <🔒> This command can only be used in a server.",
        ephemeral: true,
      });
      return;
    }
    if (!(await requiredManagerPermissions(interaction))) {
      await interaction.reply({
        content: "> <❇️> You must be an admin to initialize VC Tools. (CMD_ERR_008)",
        ephemeral: true,
      });
      return;
    }

    const method = interaction.options.getString("method")?.toLowerCase();
    if (
      !method ||
      !["ftt", "errorlogs", "transcription", "staffroles"].includes(method)
    ) {
      await interaction.reply({
        content:
          "> <❌> Invalid method. Use `ftt`, `errorlogs`, `staffroles`, or `transcription`.",
        ephemeral: true,
      });
      return;
    }

    const userId = interaction.user.id;
    interactionContexts.set(userId, {
      guildId: interaction.guild.id,
      mode: "init",
      initMethod: method,
    });

    console.log(
      `[DEBUG] handleInitializeSlashCommand: method=${method}, userId=${userId}`
    );

    switch (method) {
      case "ftt":
        await handleInitializeFTT(interaction);
        break;
      case "errorlogs":
        await handleInitializeErrorLogs(interaction);
        break;
      case "transcription":
        await handleInitializeTranscription(interaction);
        break;
      case "staffroles":
        await handleInitializeStaffRoles(interaction);
        break;
    }
  } catch (error) {
    console.error(
      `[ERROR] handleInitializeSlashCommand failed: ${error.message}`
    );
    await logErrorToChannel(
      interaction.guild?.id,
      error.stack,
      interaction.client,
      "handleInitializeSlashCommand"
    );
    if (!interaction.replied) {
      await interaction.reply({
        content:
          "> <❌> An error occurred processing the initialize command. (INT_ERR_006)",
        ephemeral: true,
      });
    }
  }
}

/* ----------------------------
     FTT FLOW (for method "ftt")
  ---------------------------- */
async function handleInitializeFlow(interaction, mode, action) {
  try {
    const guild = interaction.guild;
    const userId = interaction.user.id;

    // Check permissions
    if (!(await requiredManagerPermissions(interaction))) {
      await interaction.reply({
        content:
          "> <❌> You do not have the required permissions. (CMD_ERR_008)",
        ephemeral: true,
      });
      return;
    }

    // Retrieve context
    const context = interactionContexts.get(userId);
    if (!context) {
      await interaction.reply({
        content: "> <❌> No context found. (INT_ERR_003)",
        ephemeral: true,
      });
      return;
    }

    // Route to transcription-specific flow if initMethod is "transcription"
    if (context.initMethod === "transcription") {
      return await handleTranscriptionFlow(interaction, mode, action);
    }

    console.log(
      `[DEBUG] handleInitializeFlow called with mode=${mode}, action=${action}, initMethod=${context.initMethod}`
    );

    // Helper for role selection (Admin, Moderator, VC Moderator)
    async function handleRoleSelection(roleType, updateKey) {
      const selectedRoleId = interaction.values[0];
      const role = guild.roles.cache.get(selectedRoleId);
      if (!role) {
        await interaction.reply({
          content: `> <❌> Invalid ${roleType} role selected. Please try again.`,
          ephemeral: true,
        });
        return null;
      }
      await updateSettingsForGuild(
        guild.id,
        { [updateKey]: selectedRoleId },
        guild
      );
      console.log(
        `[DEBUG] ${roleType} role set to: ${role.name} for user ${userId}`
      );
      return role;
    }

    /* 1) Transcription Setup */
    if (action === "setup_transcription_yes") {
      await interaction.update({
        content: `## **<1.2> Choose a Transcription Logs Channel**
  > Which channel should transcription logs be saved in?

-# *Unable to find a specific channel? Log into the [Dashboard](<https://vctools.app/dashboard>) to avoid the 25 dropdown option limit.*`,
        components: [createchannelIdropdown("init", guild, userId, null)],
      });
      return;
    }
    if (action === "setup_transcription_no") {
      await interaction.update({
        content: `> <✅> **Success! Transcription setup has been skipped.**
              
  ## **<2.1> Set up error logging**
  > Would you like to set up an error logs channel in this server?`,
        components: [
          new ActionRowBuilder().addComponents(
            new ButtonBuilder()
              .setCustomId(`init:setup_error_logs_yes:${userId}`)
              .setLabel("Yes")
              .setStyle(ButtonStyle.Success),
            new ButtonBuilder()
              .setCustomId(`init:setup_error_logs_no:${userId}`)
              .setLabel("No")
              .setStyle(ButtonStyle.Danger)
          ),
        ],
      });
      return;
    }

    if (mode === "init" && action === "select_logging_channel") {
      const selectedchannelId = interaction.values[0];
      if (selectedchannelId === "new_channel") {
        const newChannel = await guild.channels.create({
          name: "transcription-logs",
          type: ChannelType.GuildText,
        });
        await updateSettingsForGuild(
          guild.id,
          { channelId: newChannel.id },
          guild
        );
        await interaction.update({
          content: `> <✅> **New channel created: <#${newChannel.id}> for transcription logs.**
      
## **<1.3> Choose who can view transcription logs**
> Select a role:

-# *Unable to find a specific role? Log into the [Dashboard](<https://vctools.app/dashboard>) to avoid the 25 dropdown option limit.*`,
          components: [createRoleDropdown("init", guild, userId, null)],
        });
        return;
      }
      await updateSettingsForGuild(
        guild.id,
        { channelId: selectedchannelId },
        guild
      );
      await interaction.update({
        content: `> <✅> **Selected <#${selectedchannelId}> for transcription logs.**
      
  ## **<1.3> Choose who can view transcription logs**
  > Select a role:

-# *Unable to find a specific role? Log into the [Dashboard](<https://vctools.app/dashboard>) to avoid the 25 dropdown option limit.*`,
        components: [createRoleDropdown("init", guild, userId, null)],
      });
      return;
    }

    if (mode === "init" && action === "select_log_viewers") {
      const selectedRoleId = interaction.values[0];
      const role = guild.roles.cache.get(selectedRoleId);
      if (!role) {
        await interaction.reply({
          content: "> <❌> Invalid role selected. Please try again.",
          ephemeral: true,
        });
        return;
      }
      await updateSettingsForGuild(
        guild.id,
        { allowedRoleId: selectedRoleId },
        guild
      );
      await interaction.update({
        content: `> <✅> **Allowed role for transcription logs set to: ${role.name}.**
      
  ## **<1.4> Enable transcription now?**
  > If enabled, transcription becomes active.`,
        components: [
          new ActionRowBuilder().addComponents(
            new ButtonBuilder()
              .setCustomId(`init:enable_transcription_yes:${userId}`)
              .setLabel("Enable")
              .setStyle(ButtonStyle.Success),
            new ButtonBuilder()
              .setCustomId(`init:enable_transcription_no:${userId}`)
              .setLabel("Disable")
              .setStyle(ButtonStyle.Danger)
          ),
        ],
      });
      return;
    }

    if (action === "enable_transcription_yes") {
      await updateSettingsForGuild(
        guild.id,
        { transcriptionEnabled: true },
        guild
      );
      await interaction.update({
        content: `> <✅> **Success! Transcription has been enabled.**
      
  ## **<2.1> Set up error logging**
  > Would you like to set up an error logs channel in this server?`,
        components: [
          new ActionRowBuilder().addComponents(
            new ButtonBuilder()
              .setCustomId(`init:setup_error_logs_yes:${userId}`)
              .setLabel("Yes")
              .setStyle(ButtonStyle.Success),
            new ButtonBuilder()
              .setCustomId(`init:setup_error_logs_no:${userId}`)
              .setLabel("No")
              .setStyle(ButtonStyle.Danger)
          ),
        ],
      });
      return;
    }
    if (action === "enable_transcription_no") {
      await updateSettingsForGuild(
        guild.id,
        { transcriptionEnabled: false },
        guild
      );
      await interaction.update({
        content: `> <❇️> **Transcription is currently disabled.** You can enable it later using \`settings transcription\`.
      
  ## **<2.1> Set up error logging**
  > Would you like to set up an error logs channel in this server?`,
        components: [
          new ActionRowBuilder().addComponents(
            new ButtonBuilder()
              .setCustomId(`init:setup_error_logs_yes:${userId}`)
              .setLabel("Yes")
              .setStyle(ButtonStyle.Success),
            new ButtonBuilder()
              .setCustomId(`init:setup_error_logs_no:${userId}`)
              .setLabel("No")
              .setStyle(ButtonStyle.Danger)
          ),
        ],
      });
      return;
    }

    /* 2) Error Logs Setup */
    if (action === "setup_error_logs_yes") {
      await interaction.update({
        content: `## **<2.2> Choose an error logs channel**
  > Which channel should errors be logged in?`,
        components: [
          createErrorLogchannelIdropdown("init", guild, userId, null),
        ],
      });
      return;
    }
    if (action === "setup_error_logs_no") {
      await interaction.update({
        content: `<❇️> **Error logging is currently disabled.** You can enable it later using \`settings transcription\`.
      
  ## **<3.1> Synchronize Roles**
  > Let **VC Tools** know which roles are part of your staff. Would you like to do this now?`,
        components: [
          new ActionRowBuilder().addComponents(
            new ButtonBuilder()
              .setCustomId(`init:add_bot_roles:${userId}`)
              .setLabel("Assign Roles")
              .setStyle(ButtonStyle.Primary),
            new ButtonBuilder()
              .setCustomId(`init:skip_bot_roles:${userId}`)
              .setLabel("Skip")
              .setStyle(ButtonStyle.Secondary)
          ),
        ],
      });
      return;
    }

    if (mode === "init" && action === "select_error_logs_channel") {
      const selectedchannelId = interaction.values[0];
      if (selectedchannelId === "new_channel") {
        const newChannel = await guild.channels.create({
          name: "error-logs",
          type: ChannelType.GuildText,
        });
        await updateSettingsForGuild(
          guild.id,
          { errorLogsChannelId: newChannel.id },
          guild
        );
        await interaction.update({
          content: `> <✅> **New channel created: <#${newChannel.id}> for error logs.**
      
  ## **<2.3> Choose who can view the error logs**
  > Select the role that can view error logs:

-# *Unable to find a specific role? Log into the [Dashboard](<https://vctools.app/dashboard>) to avoid the 25 dropdown option limit.*`,
          components: [createErrorLogRoleDropdown("init", guild, userId, null)],
        });
        return;
      }
      await updateSettingsForGuild(
        guild.id,
        { errorLogsChannelId: selectedchannelId },
        guild
      );
      await interaction.update({
        content: `> <✅> **Error logs channel set to <#${selectedchannelId}>.**
      
  ## **<2.3> Choose who can view the error logs**
  > Select the role that can view error logs:

-# *Unable to find a specific role? Log into the [Dashboard](<https://vctools.app/dashboard>) to avoid the 25 dropdown option limit.*`,
        components: [createErrorLogRoleDropdown("init", guild, userId, null)],
      });
      return;
    }

    if (mode === "init" && action === "select_error_logs_role") {
      const selectedRoleId = interaction.values[0];
      const role = guild.roles.cache.get(selectedRoleId);
      if (!role) {
        await interaction.reply({
          content: "> <❌> Invalid role selected. Please try again.",
          ephemeral: true,
        });
        return;
      }
      await updateSettingsForGuild(
        guild.id,
        { errorLogsRoleId: selectedRoleId },
        guild
      );
      await interaction.update({
        content: `> <✅> **Allowed role for error logs set to: ${role.name}.**
      
  ## **<2.4> Enable error logging now?**
  > If enabled, errors will be logged in the selected channel.`,
        components: [
          new ActionRowBuilder().addComponents(
            new ButtonBuilder()
              .setCustomId(`init:enable_error_logging_yes:${userId}`)
              .setLabel("Yes")
              .setStyle(ButtonStyle.Success),
            new ButtonBuilder()
              .setCustomId(`init:enable_error_logging_no:${userId}`)
              .setLabel("No")
              .setStyle(ButtonStyle.Danger)
          ),
        ],
      });
      return;
    }
    if (action === "enable_error_logging_yes") {
      await interaction.update({
        content: `## **<3.1> Synchronize Roles**
  > Let **VC Tools** know which roles are part of your staff. Would you like to do this now?`,
        components: [
          new ActionRowBuilder().addComponents(
            new ButtonBuilder()
              .setCustomId(`init:add_bot_roles:${userId}`)
              .setLabel("Assign Roles")
              .setStyle(ButtonStyle.Primary),
            new ButtonBuilder()
              .setCustomId(`init:skip_bot_roles:${userId}`)
              .setLabel("Skip")
              .setStyle(ButtonStyle.Secondary)
          ),
        ],
      });
      return;
    }
    if (action === "enable_error_logging_no") {
      await interaction.update({
        content: `<❇️> **Error logging is currently disabled.** You can enable it later using \`settings transcription\`.
      
  ## **<3.1> Synchronize Roles**
  > Let **VC Tools** know which roles are part of your staff. Would you like to do this now?`,
        components: [
          new ActionRowBuilder().addComponents(
            new ButtonBuilder()
              .setCustomId(`init:add_bot_roles:${userId}`)
              .setLabel("Assign Roles")
              .setStyle(ButtonStyle.Primary),
            new ButtonBuilder()
              .setCustomId(`init:skip_bot_roles:${userId}`)
              .setLabel("Skip")
              .setStyle(ButtonStyle.Secondary)
          ),
        ],
      });
      return;
    }

    /* 3) Bot Roles Setup */
    if (action === "add_bot_roles") {
      interactionContexts.set(userId, {
        guildId: guild.id,
        mode: "init_admin_role",
        initMethod: context.initMethod || "ftt",
      });
      await interaction.update({
        content: `## **<3.2> Select an Admin Role**
  > Choose the role you use for administration purposes.

-# *Unable to find a specific role? Log into the [Dashboard](<https://vctools.app/dashboard>) to avoid the 25 dropdown option limit.*`,
        components: [
          createRoleDropdown("init_admin_role", guild, userId, null),
        ],
      });
      return;
    }
    if (action === "skip_bot_roles") {
      await updateSettingsForGuild(guild.id, { setupComplete: true }, guild);
      await interaction.update({
        content: `> <✅> The bot is now fully configured.
              
  > <✅> **\`ftt\` Initialization Complete!**
  You've finished initializing everything. You can modify transcription, error logging, and staff roles later using the \`settings\` command.`,
        components: [],
      });
      return;
    }

    /* 4) Admin Role Selection */
    if (mode === "init_admin_role" && action === "select_log_viewers") {
      const role = await handleRoleSelection("Admin", "adminRoleId");
      if (!role) return;
      interactionContexts.set(userId, {
        guildId: guild.id,
        mode: "init_moderator_role",
        initMethod: context.initMethod || "ftt",
      });
      await interaction.update({
        content: `## **<3.3> Select a Moderator Role**
  > Now choose the role that moderators will use.

-# *Unable to find a specific role? Log into the [Dashboard](<https://vctools.app/dashboard>) to avoid the 25 dropdown option limit.*`,
        components: [
          createRoleDropdown("init_moderator_role", guild, userId, null),
        ],
      });
      return;
    }

    // Determine effective mode from stored context
    const effectiveMode = context.mode;
    console.log(`[DEBUG] effectiveMode = ${effectiveMode}`);

    /* 5) Moderator Role Selection */
    if (
      effectiveMode === "init_moderator_role" &&
      action === "select_log_viewers"
    ) {
      const role = await handleRoleSelection("Moderator", "moderatorRoleId");
      if (!role) return;
      // Transition to VC Moderator role selection while preserving the initMethod
      interactionContexts.set(userId, {
        guildId: guild.id,
        mode: "init_vcmoderator_role",
        initMethod: context.initMethod || "ftt",
      });
      await interaction.update({
        content: `> <✅> **Moderator role set to: ${role.name}.**
            
## **<3.4> Select a Voice Channel Moderator Role**
> Now choose the role that will moderate voice channels.

-# *Unable to find a specific role? Log into the [Dashboard](<https://vctools.app/dashboard>) to avoid the 25 dropdown option limit.*`,
        components: [
          createRoleDropdown("init:select_vcmoderator_role", guild, userId),
        ],
      });
      return;
    }

    /* 6) VC Moderator Role Selection */
    if (
      effectiveMode === "init_vcmoderator_role" &&
      (action === "select_log_viewers" || action === "select_vcmoderator_role")
    ) {
      const role = await handleRoleSelection(
        "Voice Channel Moderator",
        "vcmoderatorRoleId"
      );
      if (!role) return;
      await updateSettingsForGuild(guild.id, { setupComplete: true }, guild);
      await interaction.update({
        content: `> <✅> **Voice Channel Moderator role set to: ${role.name}.**
            
> <✅> **\`ftt\` Initialization Complete!**
You've finished initializing everything. You can modify transcription, error logging, and staff roles later inside \`settings\`. There are also extra features that you can learn more about in the **[User Guide](https://vctools.app/user-guide)**.`,
        components: [],
      });
      return;
    }

    console.log(`[DEBUG] Unrecognized FTT flow action: ${action}`);
  } catch (error) {
    console.error(`[ERROR] handleInitializeFlow failed: ${error.message}`);
  }
}

module.exports = {
  handleInitializeFTT,
  handleInitializeErrorLogs,
  handleInitializeTranscription,
  handleInitializeFlow,
  handleInitializeMessageCommand,
  handleInitializeSlashCommand,
};
