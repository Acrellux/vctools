// initialization/staffroles.cjs

const {
  Message,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} = require("discord.js");
const { updateSettingsForGuild } = require("../settings.cjs");
const { createRoleDropdown } = require("../logic/helpers.cjs");
const { interactionContexts } = require("../../database/contextStore.cjs");

/**
 * Initiates the bot roles setup flow.
 * This is a self-contained, linear flow for assigning staff roles.
 * @param {Message | Interaction} messageOrInteraction - The Discord message or interaction.
 */
async function handleInitializeStaffRoles(messageOrInteraction) {
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
    const userId = isMessage
      ? messageOrInteraction.author.id
      : messageOrInteraction.user.id;
    // Set the context for bot roles initialization.
    interactionContexts.set(userId, {
      guildId: guild.id,
      mode: "init",
      initMethod: "staffroles",
    });
    const prompt = `## **Staff Roles Setup**
> In order to secure multiple features and commands inside your server, it is a smart idea to let **VC Tools** know which roles are a part of your staff team. Would you like to do this now?`;
    const buttons = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`init:setup_botroles_yes:${userId}`)
        .setLabel("Yes")
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(`init:setup_botroles_no:${userId}`)
        .setLabel("No")
        .setStyle(ButtonStyle.Danger)
    );
    if (isMessage) {
      await messageOrInteraction.channel.send({
        content: prompt,
        components: [buttons],
      });
    } else {
      await messageOrInteraction.reply({
        content: prompt,
        components: [buttons],
      });
    }
  } catch (error) {
    console.error(
      `[ERROR] handleInitializeStaffRoles failed: ${error.message}`
    );
  }
}

/**
 * Handles the bot roles flow based on user interactions.
 * This function processes the linear bot roles flow:
 * - If the user clicks "Yes", prompt for Admin Role selection.
 * - After admin role is chosen, prompt for Moderator Role selection.
 * - If the user clicks "No", skip bot roles setup.
 * @param {Interaction} interaction - The Discord interaction object.
 * @param {string} mode - Expected to be "init".
 * @param {string} action - The action from the customId.
 */
async function handleStaffRolesFlow(interaction, mode, action) {
  try {
    const guild = interaction.guild;
    const userId = interaction.user.id;
    if (!guild) {
      await interaction.reply({
        content: "> <❌> Guild not found.",
        ephemeral: true,
      });
      return;
    }
    switch (action) {
      case "setup_botroles_yes":
        // Prompt for Admin Role selection.
        await interaction.update({
          content: `## **<3.2A> Select an Admin Role**
> Choose the role that you use for administration purposes.

-# *Unable to find a specific role? Log into the [Dashboard](<https://vctools.app/dashboard>) to avoid the 25 dropdown option limit.*`,
          components: [
            createRoleDropdown(`init:select_admin_role:${userId}`, guild, userId),
          ],
        });
        break;
      case "setup_botroles_no":
        // Skip bot roles and finish.
        await updateSettingsForGuild(guild.id, { setupComplete: true }, guild);
        await interaction.update({
          content: `> <✅> Staff roles setup skipped. Initialization complete.`,
          components: [],
        });
        interactionContexts.delete(userId);
        break;
      case "select_admin_role": {
        // Admin role selected; save it and prompt for Moderator Role.
        const selectedadminRoleId = interaction.values[0];
        const adminRole = guild.roles.cache.get(selectedadminRoleId);
        if (!adminRole) {
          await interaction.reply({
            content: "> <❌> Invalid admin role selected. Please try again.",
            ephemeral: true,
          });
          return;
        }
        await updateSettingsForGuild(
          guild.id,
          { adminRoleId: selectedadminRoleId },
          guild
        );
        await interaction.update({
          content: `> <✅> Admin role set to: ${adminRole.name}.
            
## **<3.2B> Select a Moderator Role**
> Now choose the role that moderators will use.

-# *Unable to find a specific role? Log into the [Dashboard](<https://vctools.app/dashboard>) to avoid the 25 dropdown option limit.*`,
          components: [
            createRoleDropdown(`init:select_moderator_role:${userId}`, guild, userId),
          ],
        });
        break;
      }
      case "select_moderator_role": {
        // Moderator role selected; save it and prompt for VC Moderator Role.
        const selectedmoderatorRoleId = interaction.values[0];
        const moderatorRole = guild.roles.cache.get(selectedmoderatorRoleId);
        if (!moderatorRole) {
          await interaction.reply({
            content:
              "> <❌> Invalid moderator role selected. Please try again.",
            ephemeral: true,
          });
          return;
        }
        await updateSettingsForGuild(
          guild.id,
          { moderatorRoleId: selectedmoderatorRoleId },
          guild
        );
        await interaction.update({
          content: `> <✅> Moderator role set to: ${moderatorRole.name}.
            
## **<3.2C> Select a Voice Channel Moderator Role**
> Now choose the role that will be used for voice channel moderation.

-# *Unable to find a specific role? Log into the [Dashboard](<https://vctools.app/dashboard>) to avoid the 25 dropdown option limit.*`,
          components: [
            createRoleDropdown(`init:select_vcmoderator_role:${userId}`, guild, userId),
          ],
        });
        break;
      }
      case "select_vcmoderator_role": {
        // VC Moderator role selected; save it and finish the flow.
        const selectedVcmoderatorRoleId = interaction.values[0];
        const vcModeratorRole = guild.roles.cache.get(
          selectedVcmoderatorRoleId
        );
        if (!vcModeratorRole) {
          await interaction.reply({
            content:
              "> <❌> Invalid voice channel moderator role selected. Please try again.",
            ephemeral: true,
          });
          return;
        }
        await updateSettingsForGuild(
          guild.id,
          { vcModeratorRoleId: selectedVcmoderatorRoleId, setupComplete: true },
          guild
        );
        await interaction.update({
          content: `> <✅> Voice channel moderator role set to: ${vcModeratorRole.name}.
            
> <✅> **Staff roles initialization complete!** You can edit these roles at any time by using the \`settings\` command.`,
          components: [],
        });
        interactionContexts.delete(userId);
        break;
      }
      default:
        console.warn(`[WARNING] Unrecognized staffroles action: ${action}`);
        await interaction.reply({
          content: "> <❌> Unrecognized bot roles action.",
          ephemeral: true,
        });
    }
  } catch (error) {
    console.error(`[ERROR] handleStaffRolesFlow failed: ${error.message}`);
  }
}

module.exports = {
  handleInitializeStaffRoles,
  handleStaffRolesFlow,
};
