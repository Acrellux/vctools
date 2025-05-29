const { interactionContexts } = require("../../database/contextStore.cjs");
const { logErrorToChannel } = require("./helpers.cjs");
const { handleSettingsFlow } = require("./settings_logic.cjs");
const { handleTranscriptionFlow } = require("../initialization/transcription.cjs");
const { handleErrorLogsFlow } = require("./errorlogs_logic.cjs");
const { handleInitializeFlow } = require("./init_logic.cjs");
const { grantUserConsent } = require("../settings.cjs");
const {
  handleInitializeStaffRoles,
  handleStaffRolesFlow,
} = require("../initialization/staffRoles.cjs");

const requiredManagerPermissions = ["ManageGuild"];

async function handleAllInteractions(interaction) {
  try {
    console.log(`[DEBUG] Processing interaction: ${interaction.customId}`);
    const parts = interaction.customId.split(":");
    if (parts.length < 3) {
      console.warn(
        `[WARNING] Invalid customId format: ${interaction.customId}`
      );
      return;
    }
    // Use the last element as the user ID, first as mode, and second as action.
    const userId = parts[parts.length - 1];
    const mode = parts[0];
    const action = parts[1];

    // Ensure the interaction comes from the correct user.
    if (interaction.user.id !== userId) {
      await interaction.reply({
        content: "> <❌> You cannot interact with this component. (INT_ERR_004)",
        ephemeral: true,
      });
      return;
    }

    // Fetch stored context.
    const context = interactionContexts.get(userId);
    console.log(`[DEBUG] Retrieved context for ${userId}:`, context);

    // Handle consent flow separately.
    if (mode === "consent" && action === "grant") {
      await handleConsentGrant(interaction, userId);
      return;
    }

    // If the customId mode is one of the role selection modes, handle that directly.
    if (mode === "init_admin_role" || mode === "init_moderator_role") {
      console.log(
        `[DEBUG] Handling role selection with mode=${mode}, action=${action}, userId=${userId}`
      );
      await handleInitializeFlow(interaction, mode, action);
      return;
    }

    // Special handling for initialization flows (mode === "init").
    if (mode === "init") {
      if (!context || !context.initMethod) {
        console.warn(
          `[WARNING] No initMethod found in context for user ${userId}`
        );
        // Default to FTT if no context exists.
        await handleInitializeFlow(interaction, "init", action);
      } else {
        console.log(
          `[DEBUG] Handling init interaction: initMethod=${context.initMethod}, action=${action}, userId=${userId}`
        );
        switch (context.initMethod) {
          case "transcription":
            await handleTranscriptionFlow(interaction, "init", action);
            break;
          case "errorlogs":
            await handleErrorLogsFlow(interaction, "init", action);
            break;
          case "ftt":
            await handleInitializeFlow(interaction, "init", action);
            break;
          case "staffroles":
            await handleStaffRolesFlow(interaction, "init", action);
            break;
          default:
            console.warn(`[WARNING] Unknown initMethod: ${context.initMethod}`);
            await interaction.reply({
              content: "> <❌> Unknown initialization method.",
              ephemeral: true,
            });
        }
      }
      return;
    }

    // For non-init interactions, use a handler mapping.
    const handlers = {
      settings: handleSettingsFlow,
      bot: handleSettingsFlow,
      vc: handleSettingsFlow,
      vcsettings: handleSettingsFlow,
      transcription: handleTranscriptionFlow,
      errorlogs: handleErrorLogsFlow,
      staffroles: handleStaffRolesFlow,
    };

    if (handlers[mode]) {
      console.log(
        `[DEBUG] Handling ${mode} interaction: action=${action}, userId=${userId}`
      );

      if (mode === "bot") {
        const settings = (await getSettingsForGuild(interaction.guild.id)) || {};
        const isAdmin =
          interaction.guild.ownerId === interaction.user.id ||
          interaction.member.roles.cache.has(settings.adminRoleId);

        if (!isAdmin) {
          return await interaction.reply({
            content: "> <❇️> You do not have permission to interact with Bot Settings. (INT_ERR_004)",
            ephemeral: true,
          });
        }
      }

      await handlers[mode](interaction, mode, action);
      return;
    }

    // Handle initialization role contexts if stored.
    if (["init_admin_role", "init_moderator_role"].includes(context?.mode)) {
      console.log(`[DEBUG] Handling ${context.mode} role selection`);
      await handleInitializeFlow(interaction, context.mode, action);
      return;
    }

    console.log(`[DEBUG] Unexpected mode: ${mode}`);
    await interaction.reply({
      content: "> <❌> Unexpected mode. (INT_ERR_005)",
      ephemeral: true,
    });
  } catch (error) {
    console.error(`[ERROR] handleAllInteractions failed: ${error.message}`);
    await logErrorToChannel(
      interaction.guild?.id,
      error.stack,
      interaction.client,
      "handleAllInteractions"
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

// Example consent handler (unchanged)
async function handleConsentGrant(interaction, userId) {
  try {
    let guild = interaction.guild;
    const context = interactionContexts.get(userId);

    // 🔥 Ensure we retrieve the stored guild ID if interaction.guild is null
    if (!guild) {
      if (!context || !context.guildId) {
        console.error(`[ERROR] No stored guild ID for user ${userId}`);
        await interaction.reply({
          content:
            "> <❌> Cannot determine server. Please rejoin a voice channel.",
          ephemeral: true,
        });
        return;
      }
      guild = interaction.client.guilds.cache.get(context.guildId);
      if (!guild) {
        console.error(
          `[ERROR] Guild ${context.guildId} not found for user ${userId}`
        );
        await interaction.reply({
          content: "> <❌> Error retrieving server info.",
          ephemeral: true,
        });
        return;
      }
    }

    await grantUserConsent(userId, guild);

    try {
      const member = await guild.members.fetch(userId);
      if (member.voice.channel) {
        await member.voice.setMute(false, "User consented to transcription.");
      }
    } catch (error) {
      console.error(
        `[ERROR] Failed to fetch user or unmute: ${error.message}`
      );
    }

    await interaction.reply({
      content: `> <✅> You have successfully consented to transcription and can now interact freely inside voice channels.
You can run the \`disallow\` command to revoke consent at any time.`,
      ephemeral: false,
    });

    // Cleanup context after consent is granted
    interactionContexts.delete(userId);
  } catch (error) {
    console.error(`[ERROR] handleConsentGrant failed: ${error.message}`);
  }
}

module.exports = { handleAllInteractions };
