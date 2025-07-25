const {
  Routes,
  SlashCommandBuilder,
  PermissionFlagsBits,
} = require("discord.js");
const dotenv = require("dotenv");
dotenv.config();

const commands = [
  // ==============================
  // SETTINGS COMMAND
  // ==============================
  new SlashCommandBuilder()
    .setName("settings")
    .setDescription("View or modify bot settings.")
    .addSubcommand((subcommand) =>
      subcommand
        .setName("transcription")
        .setDescription("Manage transcription settings.")
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("errorlogs")
        .setDescription("Manage error logging settings.")
    )
    .addSubcommand((subcommand) =>
      subcommand.setName("vc").setDescription("Manage voice call settings.")
    )
    .addSubcommand((subcommand) =>
      subcommand.setName("bot").setDescription("Manage bot permissions.")
    )
    .addSubcommand((s) =>
      s.setName("prefix").setDescription("Toggle which prefixes are enabled")
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("toggle")
        .setDescription("Toggle specific bot features.")
        .addStringOption((option) =>
          option
            .setName("option")
            .setDescription("Feature to toggle.")
            .setRequired(true)
            .addChoices(
              { name: "Transcription", value: "transcription" },
              { name: "Error Logs", value: "errorlogs" },
              { name: "VC Notify Bad Words", value: "vc-notify-badwords" },
              { name: "VC Notify Loud Users", value: "vc-notify-loud" }
            )
        )
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  // ==============================
  // HELP COMMAND
  // ==============================
  new SlashCommandBuilder()
    .setName("help")
    .setDescription("Get help with VC Tools commands.")
    .addSubcommand((subcommand) =>
      subcommand.setName("usage").setDescription("Explain how to use VC Tools.")
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("initialize")
        .setDescription("Details about initializing VC Tools.")
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("commands")
        .setDescription("List all available commands.")
    )
    .addSubcommand((subcommand) =>
      subcommand.setName("errors").setDescription("List all error codes.")
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("error")
        .setDescription("Get details about a specific error code.")
        .addStringOption((option) =>
          option
            .setName("code")
            .setDescription("The error code to look up.")
            .setRequired(true)
        )
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("rms")
        .setDescription("Learn about RMS detection and thresholds.")
    )
    // Extra help subcommands
    .addSubcommand((subcommand) =>
      subcommand
        .setName("notify")
        .setDescription("Understand how the notify feature can be used.")
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("settings")
        .setDescription("View help for settings commands.")
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("safeuser")
        .setDescription("Understand how the safeuser feature can be used.")
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("safechannel")
        .setDescription("Understand how the safechannel feature can be used.")
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("filter")
        .setDescription("Understand how the filter feature can be used.")
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("report")
        .setDescription("Understand how the report feature can be used.")
    ),

  // ==============================
  // INITIALIZATION COMMAND
  // ==============================
  new SlashCommandBuilder()
    .setName("initialize")
    .setDescription("Initialize VC Tools setup.")
    .addStringOption((option) =>
      option
        .setName("method")
        .setDescription("Which initialization method to use.")
        .setRequired(true)
        .addChoices(
          { name: "From the top", value: "ftt" },
          { name: "Transcription", value: "transcription" },
          { name: "Error Logging", value: "errorlogs" },
          { name: "Staff Roles", value: "staffroles" }
        )
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  // ==============================
  // VC COMMAND
  // ==============================
  new SlashCommandBuilder()
    .setName("vc")
    .setDescription("Manage users in Voice Channels.")
    .addSubcommand(sub =>
      sub
        .setName("mute")
        .setDescription("Mute user(s) in a VC.")
        .addStringOption(opt =>
          opt
            .setName("users")
            .setDescription("Mentions or IDs (space/comma-separated).")
            .setRequired(false)
        )
    )
    .addSubcommand(sub =>
      sub
        .setName("unmute")
        .setDescription("Unmute user(s) in a VC.")
        .addStringOption(opt =>
          opt
            .setName("users")
            .setDescription("Mentions or IDs (space/comma-separated).")
            .setRequired(false)
        )
    )
    .addSubcommand(sub =>
      sub
        .setName("kick")
        .setDescription("Kick user(s) from a VC.")
        .addStringOption(opt =>
          opt
            .setName("users")
            .setDescription("Mentions or IDs (space/comma-separated).")
            .setRequired(false)
        )
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMembers),

  // ==============================
  // MOD COMMAND
  // ==============================
  new SlashCommandBuilder()
    .setName("tc")
    .setDescription("Moderator text channel tools for managing users.")
    // mute
    .addSubcommand(sub =>
      sub
        .setName("mute")
        .setDescription("Server-timeout user(s).")
        .addStringOption(opt =>
          opt
            .setName("users")
            .setDescription("Mentions or IDs (space/comma-separated).")
            .setRequired(false)
        )
        .addUserOption(opt =>
          opt
            .setName("user")
            .setDescription("Single-user fallback.")
            .setRequired(false)
        )
        .addStringOption(opt =>
          opt
            .setName("duration")
            .setDescription("e.g. 10m, 2h (defaults 1h).")
            .setRequired(false)
        )
        .addStringOption(opt =>
          opt
            .setName("reason")
            .setDescription("Reason for the mute.")
            .setRequired(false)
        )
    )
    // unmute
    .addSubcommand(sub =>
      sub
        .setName("unmute")
        .setDescription("Remove timeout from user(s).")
        .addStringOption(opt =>
          opt
            .setName("users")
            .setDescription("Mentions or IDs (space/comma-separated).")
            .setRequired(false)
        )
        .addUserOption(opt =>
          opt
            .setName("user")
            .setDescription("Single-user fallback.")
            .setRequired(false)
        )
        .addStringOption(opt =>
          opt
            .setName("reason")
            .setDescription("Reason for the unmute.")
            .setRequired(false)
        )
    )
    // kick
    .addSubcommand(sub =>
      sub
        .setName("kick")
        .setDescription("Kick user(s) from the server.")
        .addStringOption(opt =>
          opt
            .setName("users")
            .setDescription("Mentions or IDs (space/comma-separated).")
            .setRequired(false)
        )
        .addUserOption(opt =>
          opt
            .setName("user")
            .setDescription("Single-user fallback.")
            .setRequired(false)
        )
        .addStringOption(opt =>
          opt
            .setName("reason")
            .setDescription("Reason for the kick.")
            .setRequired(false)
        )
    )
    // ban
    .addSubcommand(sub =>
      sub
        .setName("ban")
        .setDescription("Ban user(s) from the server.")
        .addStringOption(opt =>
          opt
            .setName("users")
            .setDescription("Mentions or IDs (space/comma-separated).")
            .setRequired(false)
        )
        .addUserOption(opt =>
          opt
            .setName("user")
            .setDescription("Single-user fallback.")
            .setRequired(false)
        )
        .addStringOption(opt =>
          opt
            .setName("reason")
            .setDescription("Reason for the ban.")
            .setRequired(false)
        )
    )
    // warn
    .addSubcommand(sub =>
      sub
        .setName("warn")
        .setDescription("Warn a user.")
        .addUserOption(opt =>
          opt
            .setName("user")
            .setDescription("The user to warn.")
            .setRequired(true)
        )
        .addStringOption(opt =>
          opt
            .setName("reason")
            .setDescription("Reason for the warning.")
            .setRequired(false)
        )
    )
    // history
    .addSubcommand(sub =>
      sub
        .setName("history")
        .setDescription("View a user's moderation history.")
        .addUserOption(opt =>
          opt
            .setName("user")
            .setDescription("The user whose history you want.")
            .setRequired(true)
        )
    )
    // unban
    .addSubcommand(sub =>
      sub
        .setName("unban")
        .setDescription("Unban a previously banned user.")
        .addUserOption(opt =>
          opt
            .setName("user")
            .setDescription("The user to unban.")
            .setRequired(true)
        )
    )
    // delete
    .addSubcommand(sub =>
      sub
        .setName("delete")
        .setDescription("Delete a moderation action by ID.")
        .addIntegerOption(opt =>
          opt
            .setName("id")
            .setDescription("The ID of the action.")
            .setRequired(true)
        )
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers),

  // ==============================
  // SAFEUSER COMMAND
  // ==============================
  new SlashCommandBuilder()
    .setName("safeuser")
    .setDescription("Manage safe users.")
    .addSubcommand((subcommand) =>
      subcommand.setName("list").setDescription("List all safe users.")
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("set")
        .setDescription("Mark a user as safe.")
        .addUserOption((option) =>
          option
            .setName("user")
            .setDescription("Select a user")
            .setRequired(true)
        )
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("remove")
        .setDescription("Remove a user from the safe list.")
        .addUserOption((option) =>
          option
            .setName("user")
            .setDescription("Select a user")
            .setRequired(true)
        )
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  // ==============================
  // SAFECHANNEL COMMAND
  // ==============================
  new SlashCommandBuilder()
    .setName("safechannel")
    .setDescription("Manage safe channels.")
    .addSubcommand((subcommand) =>
      subcommand.setName("list").setDescription("List all safe channels.")
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("set")
        .setDescription("Mark a channel as safe.")
        .addChannelOption((option) =>
          option
            .setName("channel")
            .setDescription("Select a channel")
            .setRequired(true)
        )
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("remove")
        .setDescription("Remove a channel from the safe list.")
        .addChannelOption((option) =>
          option
            .setName("channel")
            .setDescription("Select a channel")
            .setRequired(true)
        )
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  // ==============================
  // DISALLOW COMMAND
  // ==============================
  new SlashCommandBuilder()
    .setName("disallow")
    .setDescription("Remove yourself from VC Tools' database.")
    .setDefaultMemberPermissions(PermissionFlagsBits.SendMessages),

  // ==============================
  // REPORT COMMAND
  // ==============================
  new SlashCommandBuilder()
    .setName("report")
    .setDescription("Submit a report or manage existing reports.")
    .addSubcommand((subcommand) =>
      subcommand.setName("issue").setDescription("Submit an issue report.")
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("activity")
        .setDescription("Submit a report about an incident in the server.")
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("view")
        .setDescription("View your submitted report.")
        .addStringOption((option) =>
          option
            .setName("id")
            .setDescription("The report ID to view.")
            .setRequired(true)
        )
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("close")
        .setDescription("Close and delete your report.")
        .addStringOption((option) =>
          option
            .setName("id")
            .setDescription("The report ID to close.")
            .setRequired(true)
        )
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("edit")
        .setDescription("Edit a report.")
        .addStringOption((option) =>
          option
            .setName("id")
            .setDescription("The report ID to edit.")
            .setRequired(true)
        )
        .addStringOption((option) =>
          option
            .setName("field")
            .setDescription("Field to edit: description or details.")
            .setRequired(true)
            .addChoices(
              { name: "Description", value: "description" },
              { name: "Details", value: "details" }
            )
        )
        .addStringOption((option) =>
          option
            .setName("value")
            .setDescription("The new value for the selected field.")
            .setRequired(true)
        )
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.SendMessages),

  // ==============================
  // NOTIFY COMMAND
  // ==============================
  new SlashCommandBuilder()
    .setName("notify")
    .setDescription("Manage your notifications and activity visibility.")
    .addSubcommand((subcommand) =>
      subcommand
        .setName("add")
        .setDescription("Add a user to your notification list.")
        .addUserOption((option) =>
          option
            .setName("user")
            .setDescription("The user to add.")
            .setRequired(true)
        )
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("remove")
        .setDescription("Remove a user from your notification list.")
        .addUserOption((option) =>
          option
            .setName("user")
            .setDescription("The user to remove.")
            .setRequired(true)
        )
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("list")
        .setDescription("List all users on your notification list.")
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("block")
        .setDescription("Prevent an account from seeing your activity.")
        .addUserOption((option) =>
          option
            .setName("user")
            .setDescription("The user to block.")
            .setRequired(true)
        )
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("unblock")
        .setDescription(
          "Unblock an account to allow them to see your activity."
        )
        .addUserOption((option) =>
          option
            .setName("user")
            .setDescription("The user to unblock.")
            .setRequired(true)
        )
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("blocks")
        .setDescription("List the accounts you have blocked.")
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.SendMessages),

  // ==============================
  // FILTER COMMAND
  // ==============================
  new SlashCommandBuilder()
    .setName("filter")
    .setDescription("Manage the custom voice filter.")
    .addSubcommand((subcommand) =>
      subcommand
        .setName("add")
        .setDescription("Add a word to the filter list.")
        .addStringOption((option) =>
          option
            .setName("word")
            .setDescription("The word to add to the filter.")
            .setRequired(true)
        )
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("remove")
        .setDescription("Remove a word from the filter list.")
        .addStringOption((option) =>
          option
            .setName("word")
            .setDescription("The word to remove from the filter.")
            .setRequired(true)
        )
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("list")
        .setDescription("List all custom words in the filter.")
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("level")
        .setDescription("Set the filter level.")
        .addStringOption((option) =>
          option
            .setName("level")
            .setDescription("Choose the filter level.")
            .setRequired(true)
            .addChoices(
              { name: "Moderate", value: "moderate" },
              { name: "Strict", value: "strict" }
            )
        )
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  // ==============================
  // DRAIN COMMAND
  // ==============================
  new SlashCommandBuilder()
    .setName('drain')
    .setDescription('Disconnect all users from a voice channel.')
    .addChannelOption(option =>
      option.setName('channel')
        .setDescription('The voice channel to drain')
        .setRequired(true)
        .addChannelTypes(2) // Voice channels only
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.MoveMembers),
].map((command) => command.toJSON());

const { REST } = require("discord.js");
const rest = new REST({ version: "10" }).setToken(process.env.DISCORD_TOKEN);

(async () => {
  try {
    console.log("[INFO] Started refreshing application (/) commands.");

    if (process.env.GUILD_ID) {
      console.log(
        `[INFO] Registering commands for guild ID: ${process.env.GUILD_ID}`
      );
      await rest.put(
        Routes.applicationGuildCommands(
          process.env.CLIENT_ID,
          process.env.GUILD_ID
        ),
        { body: commands }
      );
    } else {
      console.log("[INFO] Registering commands globally.");
      await rest.put(Routes.applicationCommands(process.env.CLIENT_ID), {
        body: commands,
      });
    }

    console.log("[SUCCESS] Successfully reloaded application (/) commands.");
  } catch (error) {
    console.error("[ERROR] Failed to deploy commands:", error);
  }
})();
