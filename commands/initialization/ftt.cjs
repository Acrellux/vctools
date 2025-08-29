const {
  Message,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} = require("discord.js");
const { getSettingsForGuild } = require("../settings.cjs");
const { logErrorToChannel } = require("../logic/helpers.cjs");
const { interactionContexts } = require("../../database/contextStore.cjs");

/**
 * Handles the "ftt" initialization flow.
 * @param {Message | Interaction} messageOrInteraction - The Discord message or interaction object.
 */
async function handleInitializeFTT(messageOrInteraction) {
  try {
    const isMessage = messageOrInteraction instanceof Message;
    const guild = messageOrInteraction.guild;
    if (!guild) {
      const response = "> <🔒> This command can only be used within a server.";
      if (isMessage) {
        await messageOrInteraction.channel.send(response);
      } else {
        await messageOrInteraction.reply(response);
      }
      return;
    }

    const settings = await getSettingsForGuild(guild.id);
    if (settings.setupComplete) {
      const response =
        "> <❇️> Initialization has already been completed for this server.";
      if (isMessage) {
        await messageOrInteraction.channel.send(response);
      } else {
        await messageOrInteraction.reply({ content: response });
      }
      return;
    }

    // Store context for subsequent interaction handling with initMethod "ftt"
    const userId = isMessage
      ? messageOrInteraction.author.id
      : messageOrInteraction.user.id;
    interactionContexts.set(userId, {
      guildId: guild.id,
      mode: "init",
      initMethod: "ftt",
    });

    const setupMessage = `## **System Initialization ◈ From the Top**
Welcome to the system setup process! Follow the steps below to configure the bot.

## **<1.1> Set up transcription**
> Would you like to set up transcription in this server?`;

    const buttons = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`init:setup_transcription_yes:${userId}`)
        .setLabel("Yes")
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(`init:setup_transcription_no:${userId}`)
        .setLabel("No")
        .setStyle(ButtonStyle.Danger)
    );

    if (isMessage) {
      await messageOrInteraction.channel.send({
        content: setupMessage,
        components: [buttons],
      });
    } else {
      await messageOrInteraction.reply({
        content: setupMessage,
        components: [buttons],
      });
    }
  } catch (error) {
    console.error(`[ERROR] handleInitializeFTT failed: ${error.message}`);
    await logErrorToChannel(
      messageOrInteraction.guild?.id,
      error.stack,
      messageOrInteraction.client,
      "handleInitializeFTT"
    );
    if (messageOrInteraction instanceof Message) {
      await messageOrInteraction.channel.send(
        "> <❌> An error occurred during initialization. (INIT_ERR_002)"
      );
    } else {
      if (!messageOrInteraction.replied) {
        await messageOrInteraction.reply({
          content:
            "> <❌> An error occurred during initialization. (INIT_ERR_002)",
          ephemeral: true,
        });
      }
    }
  }
}

/**
 * Moves the initialization to Bot Roles setup.
 * @param {Interaction} interaction - The Discord interaction object.
 */
async function transitionToBotRoles(interaction) {
  try {
    const guild = interaction.guild;
    const userId = interaction.user.id;

    interactionContexts.set(userId, {
      guildId: guild.id,
      mode: "init",
      initMethod: "ftt",
    });

    const prompt = `## **<3.1> Synchronize Roles**
> In order to secure multiple features and commands inside your server, it is a smart idea to let **VC Tools** know which roles are a part of your staff team. Would you like to do this now?`;

    const buttons = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`init:add_bot_roles:${userId}`)
        .setLabel("Assign Roles")
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId(`init:skip_bot_roles:${userId}`)
        .setLabel("Skip")
        .setStyle(ButtonStyle.Secondary)
    );

    await interaction.update({
      content: prompt,
      components: [buttons],
    });
  } catch (error) {
    console.error(`[ERROR] transitionToBotRoles failed: ${error.message}`);
  }
}

/**
 * Moves the initialization to selecting the Admin Role.
 * @param {Interaction} interaction - The Discord interaction object.
 */
async function transitionToAdminRole(interaction) {
  try {
    const guild = interaction.guild;
    const userId = interaction.user.id;

    interactionContexts.set(userId, {
      guildId: guild.id,
      mode: "init_admin_role",
      initMethod: "ftt",
    });

    await interaction.update({
      content: `## **<3.2A> Select an Admin Role**
> Choose the role that you use for administration purposes.

-# *Unable to find a specific role? Log into the [Dashboard](<https://vctools.app/dashboard>) to avoid the 25 dropdown option limit.*`,
      components: [
        // Use a consistent custom ID format.
        createRoleDropdown("init:select_admin_role", guild, userId),
      ],
    });
  } catch (error) {
    console.error(`[ERROR] transitionToAdminRole failed: ${error.message}`);
  }
}

/**
 * Moves the initialization to selecting the Moderator Role.
 * @param {Interaction} interaction - The Discord interaction object.
 */
async function transitionToModeratorRole(interaction) {
  try {
    const guild = interaction.guild;
    const userId = interaction.user.id;

    interactionContexts.set(userId, {
      guildId: guild.id,
      mode: "init_moderator_role",
      initMethod: "ftt",
    });

    await interaction.update({
      content: `## **<3.3> Select a Moderator Role**
> Now choose the role that moderators will use.

-# *Unable to find a specific role? Log into the [Dashboard](<https://vctools.app/dashboard>) to avoid the 25 dropdown option limit.*`,
      components: [
        createRoleDropdown("init:select_moderator_role", guild, userId),
      ],
    });
  } catch (error) {
    console.error(`[ERROR] transitionToModeratorRole failed: ${error.message}`);
  }
}

/**
 * Moves the initialization to selecting the Voice Channel Moderator Role.
 * @param {Interaction} interaction - The Discord interaction object.
 */
async function transitionToVcModeratorRole(interaction) {
  try {
    const guild = interaction.guild;
    const userId = interaction.user.id;

    // 🔥 Force the correct method before handling the interaction
    interactionContexts.set(userId, {
      guildId: guild.id,
      mode: "init_vcmoderator_role",
      initMethod: "ftt",
    });

    console.log(
      `[DEBUG] transitionToVcModeratorRole: Context set for ${userId} -> mode: init_vcmoderator_role, initMethod: ftt`
    );

    await interaction.update({
      content: `## **<3.4> Select a Voice Channel Moderator Role**
> Now choose the role that will moderate voice channels.

-# *Unable to find a specific role? Log into the [Dashboard](<https://vctools.app/dashboard>) to avoid the 25 dropdown option limit.*`,
      components: [
        createRoleDropdown("init:select_vcmoderator_role", guild, userId),
      ],
    });
  } catch (error) {
    console.error(
      `[ERROR] transitionToVcModeratorRole failed: ${error.message}`
    );
  }
}

/**
 * Finalizes Bot Roles Setup.
 * @param {Interaction} interaction - The Discord interaction object.
 */
async function finalizeBotRoles(interaction) {
  try {
    await interaction.update({
      content: `> <✅> **Bot Roles Successfully Assigned.**  

> <✅> **\`ftt\` Initialization Complete!**  
You've finished initializing everything. You can modify transcription, error logging, and staff roles later by using the \`settings\` command.`,
      components: [],
    });
  } catch (error) {
    console.error(`[ERROR] finalizeBotRoles failed: ${error.message}`);
  }
}

module.exports = {
  handleInitializeFTT,
  transitionToBotRoles,
  transitionToAdminRole,
  transitionToModeratorRole,
  finalizeBotRoles,
  transitionToVcModeratorRole,
};
