var PlayerTracker = require('../PlayerTracker');

function EscBotPlayer() {
    PlayerTracker.apply(this, Array.prototype.slice.call(arguments));
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

module.exports = EscBotPlayer;
EscBotPlayer.prototype = new PlayerTracker();

// Functions

EscBotPlayer.prototype.getLowestCell = function() {
    // Gets the cell with the lowest mass
    if (this.cells.length <= 0) {
        return null; // Error!
    }

    // Starting cell
    var lowest = this.cells[0];
    for (i = 1; i < this.cells.length; i++) {
        if (lowest.mass > this.cells[i].mass) {
            lowest = this.cells[i];
        }
    }
    return lowest;
};

// Override

EscBotPlayer.prototype.updateSightRange = function() { // For view distance
    var range = 1000; // Base sight range

    if (this.cells[0]) {
        range += this.cells[0].getSize() * 2.5;
    }

    this.sightRangeX = range;
    this.sightRangeY = range;
};

EscBotPlayer.prototype.update = function() { // Overrides the update function from player tracker
    // Remove nodes from visible nodes if possible
    for (var i = 0; i < this.nodeDestroyQueue.length; i++) {
        var index = this.visibleNodes.indexOf(this.nodeDestroyQueue[i]);
        if (index > -1) {
            this.visibleNodes.splice(index, 1);
        }
    }

    // Update every 500 ms
    if ((this.tickViewBox <= 0) && (this.gameServer.run)) {
        this.visibleNodes = this.calcViewBox();
        this.tickViewBox = 10;
    } else {
        this.tickViewBox--;
        return;
    }

    // Respawn if bot is dead
    if (this.cells.length <= 0) {
        this.gameServer.gameMode.onPlayerSpawn(this.gameServer,this);
        this.deadTimes++;
        if (this.cells.length == 0) {
            // If the bot cannot spawn any cells, then disconnect it
            this.socket.close();
            return;
        }
    }

    // Calc predators/prey
    var cell = this.getLowestCell();
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

    this.nodeDestroyQueue = []; // Empty

};

// Custom

EscBotPlayer.prototype.clearLists = function() {
    this.predators = [];
    this.threats = [];
    this.prey = [];
    this.food = [];
    this.virus = [];
    this.juke = false;
};

EscBotPlayer.prototype.getState = function(cell) {
    // Check for predators
    if (this.predators.length <= 0) {
        if (this.virus.length > 0) {
            nearestVirus = this.findNearest(cell, this.virus);
            if (this.getDist(cell,nearestVirus) < cell.getSize() * 2) {
                return 4;
            }
        }
        return 0;
    }
    else if (this.threats.length > 0) {
        if (this.cells.length == 1 && this.predators.length > 0) {
            var t = this.getBiggest(this.threats);
            var tl = this.findNearbyVirus(t, 500, this.virus);
            if (tl != false) {
                if (cell.mass < 100){
                    this.target = t;
                    this.targetVirus = tl;
                    return 5;
                }
            }
        }
        // Run
        return 2;
    }

    // Bot wanders by default
    return 0;
};

EscBotPlayer.prototype.decide = function(cell) {
    // The bot decides what to do based on gamestate
    switch (this.gameState) {
        case 0: // Wander
            //console.log("[Bot] "+cell.getName()+": Wandering");
            if ((this.centerPos.x == this.mouse.x) && (this.centerPos.y == this.mouse.y)) {
                pos = this.gameServer.getRandomPosition();

                // Set bot's mouse coords to this location
                this.mouse = {x: pos.x, y: pos.y};
            }
            break;
        case 2: // Run from (potential) predators
            var avoid = this.combineVectors(this.threats);
            if (this.predators.length > 0)
              avoid = this.combineVectors(this.predators);
            //console.log("[Bot] "+cell.getName()+": Fleeing from "+avoid.getName());

            // Find angle of vector between cell and predator
            var deltaY = avoid.y - cell.position.y;
            var deltaX = avoid.x - cell.position.x;
            var angle = Math.atan2(deltaX,deltaY);

            // Now reverse the angle
            if (angle > Math.PI) {
                angle -= Math.PI;
            } else {
                angle += Math.PI;
            }

            // Direction to move
            var x1 = cell.position.x + (500 * Math.sin(angle));
            var y1 = cell.position.y + (500 * Math.cos(angle));
            if (cell.position.x > 5500)
                x1 = 4500;
            else if (cell.position.x < 1500)
                x1 = 2500;
            if (cell.position.y > 5500)
                y1 = 4500;
            else if (cell.position.y < 1500)
                y1 = 2500;

            this.mouse = {x: x1, y: y1};

            if (this.juke) {
                // Juking
                this.gameServer.splitCells(this);
            }

            //console.log(this.mouse);
            break;
        case 4: //Stay away from virus
            var avoid = this.findNearest(cell, this.virus);
            // Find angle of vector between cell and predator
            var deltaY = avoid.position.y - cell.position.y;
            var deltaX = avoid.position.x - cell.position.x;
            var angle = Math.atan2(deltaX,deltaY);

            // Now reverse the angle
            if (angle > Math.PI) {
                angle -= Math.PI;
            } else {
                angle += Math.PI;
            }

            // Direction to move
            var x1 = cell.position.x + (500 * Math.sin(angle));
            var y1 = cell.position.y + (500 * Math.cos(angle));

            this.mouse = {x: x1, y: y1};

            // console.log("[Bot] "+cell.getName()+": Targeting (virus) "+this.target.getName());
            break;
        case 5: // hide into virus
            this.mouse = {x: this.targetVirus.position.x, y: this.targetVirus.position.y};
            if (this.getDist(cell, this.targetVirus) > this.getDist(this.predators[0], this.targetVirus))
                var avoid = this.combineVectors(this.predators);

                if (!avoid) {
                    var pos = {x: 0, y: 0};
                    var check;
                    for (var i = 0; i < this.predators.length; i++) {
                        check = this.predators[i];
                        pos.x += check.position.x;
                        pos.y += check.position.y;
                    }

                    // Get avg
                    pos.x = pos.x/this.predators.length;
                    pos.y = pos.y/this.predators.length;

                    avoid = pos;
                }

                // Find angle of vector between cell and predator
                var deltaY = avoid.y - cell.position.y;
                var deltaX = avoid.x - cell.position.x;
                var angle = Math.atan2(deltaX,deltaY);

                // Now reverse the angle
                if (angle > Math.PI) {
                    angle -= Math.PI;
                } else {
                    angle += Math.PI;
                }

                // Direction to move
                var x1 = cell.position.x + (500 * Math.sin(angle));
                var y1 = cell.position.y + (500 * Math.cos(angle));
                this.mouse = {x: x1, y:y1};
            break;
        default:
            //console.log("[Bot] "+cell.getName()+": Idle "+this.gameState);
            this.gameState = 0;
            break;
    }

    // Recombining
    if (this.cells.length > 1) {
        var r = 0;
        // Get amount of cells that can merge
        for (var i in this.cells) {
            if (this.cells[i].recombineTicks == 0) {
                r++;
            }
        }
        // Merge 
        if (r >= 2) {
            this.mouse.x = this.centerPos.x;
            this.mouse.y = this.centerPos.y;
        }
    } 
};

// Finds the nearest cell in list
EscBotPlayer.prototype.findNearest = function(cell,list) {
    if (this.currentTarget) {
        // Do not check for food if target already exists
        return null;
    }

    // Check for nearest cell in list
    var shortest = list[0];
    var shortestDist = this.getDist(cell,shortest);
    for (var i = 1; i < list.length; i++) {
        var check = list[i];
        var dist = this.getDist(cell,check);
        if (shortestDist > dist) {
            shortest = check;
            shortestDist = dist;
        }
    }

    return shortest;
};

EscBotPlayer.prototype.getRandom = function(list) {
    // Gets a random cell from the array
    var n = Math.floor(Math.random() * list.length);
    return list[n];
};

EscBotPlayer.prototype.combineVectors = function(list) {
    // Gets the angles of all enemies approaching the cell
    var pos = {x: 0, y: 0};
    var check;
    for (var i = 0; i < list.length; i++) {
        check = list[i];
        pos.x += check.position.x;
        pos.y += check.position.y;
    }

    // Get avg
    pos.x = pos.x/list.length;
    pos.y = pos.y/list.length;

    return pos;
};

EscBotPlayer.prototype.checkPath = function(cell,check) {
    // Checks if the cell is in the way

    // Get angle of vector (cell -> path)
    var v1 = Math.atan2(cell.position.x - this.mouse.x,cell.position.y - this.mouse.y);

    // Get angle of vector (virus -> cell)
    var v2 = this.getAngle(check,cell);
    v2 = this.reverseAngle(v2);

    if ((v1 <= (v2 + .25) ) && (v1 >= (v2 - .25) )) {
        return true;
    } else {
        return false;
    }
};

EscBotPlayer.prototype.getBiggest = function(list) {
    // Gets the biggest cell from the array
    var biggest = list[0];
    for (var i = 1; i < list.length; i++) {
        var check = list[i];
        if (check.mass > biggest.mass) {
            biggest = check;
        }
    }

    return biggest;
};

EscBotPlayer.prototype.findNearbyVirus = function(cell,checkDist,list) {
    var r = cell.getSize() + 100; // Gets radius + virus radius
    for (var i = 0; i < list.length; i++) {
        var check = list[i];
        var dist = this.getDist(cell,check) - r;
        if (checkDist > dist) {
            return check;
        }
    }
    return false; // Returns a bool if no nearby viruses are found
};

EscBotPlayer.prototype.checkPath = function(cell,check) {
    // Get angle of path
    var v1 = Math.atan2(cell.position.x - player.mouse.x,cell.position.y - player.mouse.y);

    // Get angle of vector (cell -> virus)
    var v2 = this.getAngle(cell,check);
    var dist = this.getDist(cell,check);

    var inRange = Math.atan((2 * cell.getSize())/dist); // Opposite/adjacent
    console.log(inRange);
    if ((v1 <= (v2 + inRange)) && (v1 >= (v2 - inRange))) {
        // Path collides
        return true;
    } 

    // No collide
    return false;
}

EscBotPlayer.prototype.getDist = function(cell,check) {
    // Fastest distance - I have a crappy computer to test with :(
    var xd = (check.position.x - cell.position.x);
    xd = xd < 0 ? xd * -1 : xd; // Math.abs is slow

    var yd = (check.position.y - cell.position.y);
    yd = yd < 0 ? yd * -1 : yd; // Math.abs is slow

    return (xd + yd);
};

EscBotPlayer.prototype.getAccDist = function(cell,check) {
    // Accurate Distance
    var xs = check.position.x - cell.position.x;
    xs = xs * xs;

    var ys = check.position.y - cell.position.y;
    ys = ys * ys;

    return Math.sqrt( xs + ys );
};

EscBotPlayer.prototype.getAngle = function(c1,c2) {
    var deltaY = c1.position.y - c2.position.y;
    var deltaX = c1.position.x - c2.position.x;
    return Math.atan2(deltaX,deltaY);
};

EscBotPlayer.prototype.reverseAngle = function(angle) {
    if (angle > Math.PI) {
        angle -= Math.PI;
    } else {
        angle += Math.PI;
    }
    return angle;
};

