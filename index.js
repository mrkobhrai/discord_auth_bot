/*
 * Initialises discord.js library
 * Retrieves configuration for bot runtime
 */
const Discord = require('discord.js');
const server = require('./disc_config.json')

/*
 * Environment based imports
 */
const dotenv = require('dotenv');
dotenv.config();

const auth = {
    "token": process.env.DISCORDTOKEN
}

const serviceAccount = {
    "type": process.env.SERVICETYPE,
    "project_id": process.env.SERVICEPROJECTID,
    "private_key_id": process.env.SERVICEPRIVATEID,
    "private_key": process.env.SERVICEPRIVATEKEY.replace(/\\n/g, '\n'),
    "client_email": process.env.SERVICECLIENTEMAIL,
    "client_id": process.env.SERVICECLIENTID,
    "auth_uri": process.env.SERVICEAUTHURI,
    "token_uri": process.env.SERVICETOKENURI,
    "auth_provider_x509_cert_url": process.env.SERVICEAUTHPROVIDERCERT,
    "client_x509_cert_url": process.env.SERVICECLIENTCERT
  }

const database_uri = {
    "uri": process.env.DATABASEURI
}
/*
 * Initialises bot and Discord API keys
 */
const bot  = new Discord.Client();
const admin = require("firebase-admin");

/*
 * Part of the configuration variables
 * Guild is the Discord Server
 * Course roles stores all the roles related to courses and the 'Verified' role
 * Year roles store all roles related to years e.g. 1st, 2nd..
 * Committee role is kept seperate so has to be accessed directly
 * Log channel is the channel where all of this bot logs are sent
 * Log book is the current logs stored in the session, these are not stored in the database
 * The email transporter is the variable which stores the open SMTP channel for sending emails
 */
var guild;

var course_roles = {};
var year_roles = {};

var COMMITTEE_ROLE;

var log_channel;
var welcome_channel;
var logbook = [];

var email_transporter;

/*
 * Initialises Firebase API keys
 */

const { user } = require('firebase-functions/lib/providers/auth');


/*
 *  Login DISCORD BOT with custom token
 */
bot.login(auth.token);

/*
 *  Initialise FIREBASE connection
 */
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: (database_uri.uri)
});

/*
 *  Initialise FIREBASE database reference pointers
 */
const database = admin.database();
const queue_ref = database.ref("/queue");
const verified_users = database.ref("/users");

/*
 *  Configured variable to ensure configuration worked correctly
 */
var configured = false;

/*
 * ==================================================
 *              Discord Event Listeners
 * ==================================================
 */

/*
 * On Bot load up, attempt to configure it. If configuration is successful
 * notify admins on 'log' channnel
 */
bot.on('ready', () => {
    log("Attempting to run bot!");
    configure().then(function(){
        log("Bot running!");
        print_commands();
        setTimeout(function(){notify_unverified_users()}, 2000);
    }).catch(log);
});

/*
 * Check for command '!notify_unverified' which notifies all unverified users by sending them their custom auth url
 * Should be done every time the Discord Bot is reloaded to deal with any users who joined while the bot was offline
 */
bot.on('message', message => {
    if(message.content === '!notify_unverified' && message.member != null && message.member.hasPermission("ADMINISTRATOR")){
        notify_unverified_users();
    }
});

/*
 * Check for command '!kick <user>' which kicks a user a deletes their data from the db
 */
bot.on('message', message => {
    if(message.content.startsWith('!kick') && message.member != null && message.member.hasPermission("ADMINISTRATOR")){
        message.mentions.users.forEach(function(user){
            var guildmember = get_member(user.id);
            if(guildmember != null){
                guildmember.kick();
                log("Kicked member:" + guildmember.nickname + " with discord id:" + guildmember.id);
            }else{
                log("No member found with id:" + user.id);
            }
        });
    }
});


/*
 * Unverify command to remove shortcodes registered to this user account
 */
bot.on('message',async function(message){
    if(message.content.startsWith('!unverify') && message.member != null){
        if(message.member.hasPermission("ADMINISTRATOR")){
            message.mentions.users.forEach(async function(user){
                var member = get_member(user.id);
                member.send("This account has been unverified and will now be reset");
            var shortcode = await get_shortcode(member.id);
            if(shortcode.length <= 0){
                return;
            }
            member.roles.set([]);
            log("Unverifying user currently registered under shortcode:" + shortcode[0]);
            verified_users.child(shortcode[0]).remove();
            
            })
            message.delete();
        }else{
            message.member.send("This account has been unverified and will now be reset");
            var shortcode = await get_shortcode(message.member.id);
            if(shortcode.length <= 0){
                return;
            }
            message.member.roles.set([]);
            log("Unverifying user currently registered under shortcode:" + shortcode[0]);
            verified_users.child(shortcode[0]).remove();
        }
    }
})
/*
 * Check for command '!help' which lists all commands
 */
bot.on('message', message => {
    if(message.content === '!help' && message.member != null){
        if(message.member.hasPermission("ADMINISTRATOR")){
            print_commands();
        }else{
            var member = message.member;
            member.send("=====================COMMANDS====================");
            member.send("!help (Shows commands)");
            member.send("!unverify (Resets your discord account and clears the user registered under it")
            member.send("=================================================");
        }
        message.delete();
    }
});

/*
 * Check for command '!verify' which lists all commands
 */
bot.on('message', message => {
    if(message.content === '!verify' && message.member != null){
        send_user_auth_url(message.member);
    }
});

/*
 * Check for command '!logs' which prints all logs in the current bot session
 */
bot.on('message', message => {
    if(message.content === '!logs' && message.member != null && message.member.hasPermission("ADMINISTRATOR") && configured){
        log_channel.send("-----BEGIN LOGBOOK-----");
        log_channel.send("LOGS:" + logbook.length);
        logbook.forEach((log) => log_channel.send("`"+log+"`"));
        log_channel.send("-----END LOGBOOK-----");
    }
});

/*
 * Check for command '!committee' and a mention which gives the committee role to a member
 */
bot.on('message', message => {
    if(message.content.startsWith('!committee') && message.member != null && message.member.hasPermission("ADMINISTRATOR") && configured){
        if(message.mentions.users.size > 1){
            log("Can only add one user at a time to committee for security reasons :)");
            message.delete();
            return;
        }
        message.mentions.users.forEach(function(member){
            var guildmember = get_member(member.id);
            if(guildmember == null){
                log("Trying to add member to committee but unknown member with userid: " + member.id);
            }else{
                guildmember.roles.add(COMMITTEE_ROLE).catch((error)=>log("Tried adding member:" + user.id + "to committee but failed with error:" + error));
                log("Successfully added member " + member.username+ " to committee group :) by user with username:" + message.author.username);
                
            }
        });
        message.delete();
    }
});

/*
 * Check for command '!clear_log_chat' which clears the chat
 */
bot.on('message', message => {
    if(message.content === '!clear_log_chat' && message.member != null && message.member.hasPermission("ADMINISTRATOR") && configured){
        message.reply("Deleting logs!");
        log_channel.messages.cache.forEach((message)=> message.delete());
    }
});

/*
 * Check for command '!config' which prints the server configuration
 */
bot.on('message', message => {
    if(message.content === '!config' && message.member != null && message.member.hasPermission("ADMINISTRATOR") && configured){
        print_server_config();
    }
});
/*
 * When a member is added, log them joining and send them their custom auth url
 */
bot.on('guildMemberAdd', member => {
    member.send("Welcome to the RCSU Discord Server!");
    welcome_channel.send("Welcome to the RCSU Server, <@"+member.id+">, please check your DM's to verify your account")
    log("New Member Joined:" + member.displayName);
    send_user_auth_url(member);
});

function notify_unverified_users(){
    return;
    var notifications = 0;
    if(configured){
        log("Beginning: Notifiying Unverified Users");
        guild.members.cache.forEach(guildMember => {
            if(!guildMember.roles.cache.find( role => role.id === server.roles.Verified)){
                send_user_auth_url(guildMember);
                notifications++;
            }
        });
        log(notifications + " users notified!");
        log("Ending: Notifiying Unverified Users");
    }else{
        log("Can't clear backlog, configuration not set!");
    }
}
/*
 * ==================================================
 *                DATABASE LISTENERS
 * ==================================================
 */

/*
 * Database event listener. Interestingly, listener takes all backlog from when the bot was offline
 * Takes queued authentication and attempts to verify user members associated with each account
 */


function on_queue(snapshot, prevChildKey){
    if(!configured){
        log("Not configured, can't deal with queue!");
        return;
    }
    db_user = snapshot.val();
    var member = get_member(db_user.id);
    if(member == null){
        log("User not found through login with shortcode:" + db_user.shortcode + ". Discord ID attempted:" + db_user.id);
        queue_ref.child(snapshot.key).remove();
    }else{
        var shortcode = db_user.shortcode;
        var course = db_user.course;
        var year = db_user.year;
        verified_users.child(shortcode).once('value', async function(fetched_snapshot){
            var alternate_shortcode = await get_shortcode(db_user.id).then(async function(alternate_shortcode){
                if((alternate_shortcode[0] || shortcode) != shortcode){
                    member.send("IMPORTANT:You're already verified under "+alternate_shortcode[0]+"! Someone just tried to reverify this account! \n\nDid you send someone your authentication link or try and reuse it yourself! This account is already registered to a shortcode. If you wish to update any information e.g. course or year, please contact an admin");
                    log("Member already verified with discord id " + member.id + " and member with shortcode: " + shortcode + " attempted to reverify this account. This is not allowed!");
                    queue_ref.child(snapshot.key).remove();
                    return;
                }
                else if(fetched_snapshot.val() === null || fetched_snapshot.val().disc_id === db_user.id){
                    if(fetched_snapshot.val() !== null && fetched_snapshot.val().disc_id === db_user.id){
                        //Reset member roles
                        await member.roles.set([]);
                    }
                    member.roles.add(course_roles["Verified"])
                    if(Object.keys(server.roles).includes(course)){
                        member.roles.add(course_roles[course]);
                    }else{
                        log("Unidentified course :" + course + " when trying to add member" + shortcode);
                    }

                    if(Object.keys(server.years).includes(year)){
                        member.roles.add(year_roles[year]);
                    }else{
                        log("Unidentified year :" + year + " when trying to add member" + db_user.shortcode);
                    }
                    log("Member signed up successfully with username: " + member.user.username + " and id: " + member.user.id +" and course group: "+course+" and year: "+ year +"!");
                    var userid = member.toJSON().userID.toString();
                    verified_users.child(shortcode).set({"username": member.user.username,"disc_id" : userid, "course": course, "year": year});
                    member.send("Well done! You've been verified as a member!");
                    member.send("You are now free to explore the server and join in with RCSU Events!");
                    member.send("Use the '!help' command in any channel to get a list of available commands");
                }else{
                    log("Member signed in successfully. \n However this shortcode is already associated with discord id: "+ fetched_snapshot.val().disc_id + "\n so can't be associated with discord id: " + snapshot.val().id);
                    member.send("This shortcode is already registered to a Discord User!");
                    member.send('If you believe this is an error, please contact an Admin');
                }
            })
        })
    }
    queue_ref.child(snapshot.key).remove();
}


/*
 * ==================================================
 *                  HELPER FUNCTIONS
 * ==================================================
 */

 
/*
 * Logs to both console and to discord log channel if it exists
 */
function log(log){
    console.log(log);
    logbook.push(new Date(Date.now()).toLocaleString() + ":" + log);
    if(log_channel != null){
        log_channel.send("`"+log+"`");
    }
}

/*
 * Gets a channel given an id 
 * Pre: configured
 */
function get_channel(id){
    return guild.channels.cache.get(id);
}

/*
 * Gets a role given an id 
 * Pre: configured
 */
async function get_role(role_id){
    var result = await guild.roles.fetch(role_id).then(role=>role);
    return result;
} 

/*
 * Gets a member given an id 
 * Pre: configured
 */
function get_member(id){
    return guild.member(id);
}

/*
 * Prints the server configuration
 */
function print_server_config(){
    log("Server Config:\n-> SERVER: " + guild + "\n-> LOG CHANNEL: " + log_channel.name);    
}

/*
 * Prints the commands 
 */
function print_commands(){
    log("-----------COMMANDS-------------");
    log("!help (Shows commands)");
    log("!kick [<user>] (Kicks mentioned users)")
    log("!logs (View all logs!)")
    log("!clear_log_chat (Clear the log chat from this runtimes logs)")
    log("!config (Prints the Server config)");
    log("!committee <user> (Gives a single user committee role, user @ to mention them as the argument!)");
    log("!notify_unverified (Notifies all unverified users with their custom URL) ")
    log("!verify (Get your link to verify your discord account)")
    log("!unverify [<user>] (Unverifies a set of users by mentions)")
}



/*
 * Given a member object, sends the member their custom auth url
 */
function send_user_auth_url(member){
    try{
        var message = "Just one last step to get into the IC RCSU server :)\n"+"To complete your sign-up and verify your Discord Account, please fill in the form below:\n" + "https://rcsu-discord-auth.web.app/"+ member.id + "\nPlease note the URL will only be relevant to you";
        sendMessage(member, message);
        log("Sent authentication URL to member:" + member.id);
    }catch(ex){
        log(ex);
    }
}


function sendMessage(member, message){
    member.send(message).catch(log);
}
/*
* Fetch user shortcode from userid
*/
async function get_shortcode(disc_id){
    var result = [];
    await verified_users.orderByChild("disc_id").equalTo(disc_id).once('value').then(
        function(super_snap){
            if(super_snap.exists()){
                //Accounting for issue that may be multiply shortcodes associated to discord id
                //Bot won't like it, but it'll work, functionality only enabled for first result
                result = Object.keys(super_snap.val());
            }
        }
    ).catch(function(error){
        log("Tried to fetch the shortcode of a user with discord id: " + disc_id);
        log("Failed with error:\n" + error);
    });
    return result;
}

/*
 * Configures basics e.g. guild, log channel, verified role by fetching id from disc_config.json
 * If configuration fails, the bot should stop running after logging error!
 */
async function configure(){
    try{
        guild = bot.guilds.cache.get(server.SERVER_ID);
        log_channel = get_channel(server.LOG_CHANNEL_ID);
        welcome_channel = get_channel(server.WELCOME_CHANNEL_ID);
        //Populate roles
        for(var role in server.roles){
            //Left as console log to reduce initialisation spam
            //Errors will be sent to server
            console.log("Fetching role: " + role);
            course_roles[role] = await get_role(server.roles[role]).then((role)=> role).catch((error)=>log("Role fetch error on role " + role + " with error" + error));
        }

        for(var role in server.years){
            //Left as console log to reduce initialisation spam
            //Errors will be sent to server
            console.log("Fetching year role: " + role);
            year_roles[role] = await get_role(server.years[role]).then((role)=> role).catch(log);
        }
        //Left as console log to reduce initialisation spam
        //Errors will be sent to server
        console.log("Fetching committee role");
        COMMITTEE_ROLE = await get_role(server.COMMITTEE_ROLE_SAFE).then((role)=>role).catch(log);
    } catch(error){
        log("FATAL!!!");
        log("CONFIGURATION FAILED WITH ERROR:");
        log(error);
    } finally{
        configured = true;
        log("-----------BOT BEGINS-----------");
        log("Bot Configured successfully!");
        print_server_config();   
        queue_ref.on("child_added", async function(snapshot,prevChildKey){
            on_queue(snapshot,prevChildKey);
        });     
    }
}


/**
 * Augment Functions
 */
function year_up(){
    guild.members.cache.forEach((member)=>{
            member.send("New university year, new you :) For security reasons we ask that you reauthenticate your RCSU membership and update your details for the upcoming year!");
            member.send("You will be unable to use the server normally until you update your details");
            if(!member.user.bot){
                member.roles.set([]);
            }
    });
    verified_users.remove();       
}