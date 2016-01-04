var Packet = require('../packet');
var PlayerTracker = require('../PlayerTracker');
var BotPlayer = require('./BotPlayer');
var MyBotPlayer = require('./MyBotPlayer');
var GreedyBotPlayer = require('./GreedyBotPlayer');
var RndBotPlayer = require('./RndBotPlayer');
var EscBotPlayer = require('./EscBotPlayer');

function PlayerAI() {
    //PlayerTracker.apply(this, Array.prototype.slice.call(arguments));
    //BotPlayer.apply(this, Array.prototype.slice.call(arguments));
    MyBotPlayer.apply(this, Array.prototype.slice.call(arguments));
    //GreedyBotPlayer.apply(this, Array.prototype.slice.call(arguments));
    //RndBotPlayer.apply(this, Array.prototype.slice.call(arguments));
    //EscBotPlayer.apply(this, Array.prototype.slice.call(arguments));
    //this.color = gameServer.getRandomColor();

    // AI only
    this.gameState = 0;
    this.path = [];

    this.predators = []; // List of cells that can eat this bot
    this.threats = []; // List of cells that can eat this bot but are too far away
    this.prey = []; // List of cells that can be eaten by this bot
    this.food = [];
    this.foodImportant = []; // Not used - Bots will attempt to eat this regardless of nearby prey/predators
    this.virus = []; // List of viruses

    this.juke = false;

    this.target;
    this.targetVirus; // Virus used to shoot into the target

    this.ejectMass = 0; // Amount of times to eject mass
    this.oldPos = {x: 0, y:0};
}

module.exports = PlayerAI;
//PlayerAI.prototype = new PlayerTracker();
//PlayerAI.prototype = new BotPlayer();
PlayerAI.prototype = new MyBotPlayer();
//PlayerAI.prototype = new GreedyBotPlayer();
//PlayerAI.prototype = new RndBotPlayer();
//PlayerAI.prototype = new EscBotPlayer();

PlayerAI.prototype.update = function() { // Overrides the update function from player tracker
    var updateNodes = []; // Nodes that need to be updated via packet
    
    // Remove nodes from visible nodes if possible
    var d = 0;
    while (d < this.nodeDestroyQueue.length) {
        var index = this.visibleNodes.indexOf(this.nodeDestroyQueue[d]);
        if (index > -1) {
            this.visibleNodes.splice(index, 1);
            d++; // Increment
        } else {
            // Node was never visible anyways
            this.nodeDestroyQueue.splice(d,1);
        }
    }
    
    // Get visible nodes every 400 ms
    var nonVisibleNodes = []; // Nodes that are not visible
    if (this.tickViewBox <= 0) {
        var newVisible = this.calcViewBox();

        // Compare and destroy nodes that are not seen
        for (var i = 0; i < this.visibleNodes.length; i++) {
            var index = newVisible.indexOf(this.visibleNodes[i]);
            if (index == -1) {
                // Not seen by the client anymore
                nonVisibleNodes.push(this.visibleNodes[i]);
            }
        }
        
        // Add nodes to client's screen if client has not seen it already
        for (var i = 0; i < newVisible.length; i++) {
            var index = this.visibleNodes.indexOf(newVisible[i]);
            if (index == -1) {
                updateNodes.push(newVisible[i]);
            }
        }
        
        this.visibleNodes = newVisible;
        // Reset Ticks
        this.tickViewBox = 2;
    } else {
        this.tickViewBox--;
        // Add nodes to screen
        for (var i = 0; i < this.nodeAdditionQueue.length; i++) {
            var node = this.nodeAdditionQueue[i];
            this.visibleNodes.push(node);
            updateNodes.push(node);
        }
    }
    
    // Update moving nodes
    for (var i = 0; i < this.visibleNodes.length; i++) {
        var node = this.visibleNodes[i];
        if (node.sendUpdate()) {
            // Sends an update if cell is moving
            updateNodes.push(node);
        }
    }

    // Send packet
    this.socket.sendPacket(new Packet.UpdateNodes(this.nodeDestroyQueue, updateNodes, nonVisibleNodes));

    this.nodeDestroyQueue = []; // Reset destroy queue
    this.nodeAdditionQueue = []; // Reset addition queue

    // Update leaderboard
    if (this.tickLeaderboard <= 0) {
        this.socket.sendPacket(this.gameServer.lb_packet);
        this.tickLeaderboard = 10; // 20 ticks = 1 second
    } else {
        this.tickLeaderboard--;
    }

    // Handles disconnections
    if (this.disconnect > -1) {
        // Player has disconnected... remove it when the timer hits -1
        this.disconnect--;
        if (this.disconnect == -1) {
            // Remove all client cells
            var len = this.cells.length;
            for (var i = 0; i < len; i++) {
                var cell = this.socket.playerTracker.cells[0];

                if (!cell) {
                    continue;
                }

                this.gameServer.removeNode(cell);
            }

            // Remove from client list
            var index = this.gameServer.clients.indexOf(this.socket);
            if (index != -1) {
                this.gameServer.clients.splice(index,1);
            }
        }
    }

    // Check if player is dead
    if (this.cells.length <= 0) return;

    // Calc predators/prey
    var cell = this.getLowestCell();
    //var cell = this.getBiggestCell();
    var r = cell.getSize();
    this.clearLists();

    // Ignores targeting cells below this mass
    var ignoreMass = Math.min((cell.mass / 10), 150); 

    // Loop
    for (i in this.visibleNodes) {
        var check = this.visibleNodes[i];

        // Cannot target itself
        if ((!check) || (cell.owner == check.owner)){
            continue;
        }

        var t = check.getType();
        switch (t) {
            case 0:
                // Cannot target teammates
                if (this.gameServer.gameMode.haveTeams) {
                    if (check.owner.team == this.team) {
                        continue;
                    }
                }

                // Check for danger
                if (cell.mass > (check.mass * 1.25)) {
                    // Add to prey list
                    this.prey.push(check);
                } else if (check.mass > (cell.mass * 1.25)) {
                    // Predator
                    var dist = this.getDist(cell, check) - (r + check.getSize());
                    if (dist < 300) {
                        this.predators.push(check);
                        if ((this.cells.length == 1) && (dist < 0)) {
                            this.juke = true;
                        }
                    }
                    this.threats.push(check);
                } else {
                    this.threats.push(check);
                }
                break;
            case 1:
                this.food.push(check);
                break;
            case 2: // Virus
                this.virus.push(check);
                break;
            case 3: // Ejected mass
                if (cell.mass > 20) {
                    this.food.push(check);
                }
                break;
            default:
                break;
        }
    }

    // Get gamestate
    var newState = this.getState(cell);
    if ((newState != this.gameState) && (newState != 4)) {
        // Clear target
        this.target = null;
    }
    this.gameState = newState;

    // Action
    this.decide(cell);
};

