"use strict";

/*
 * MIT License
 *
 * Copyright (c) 2018 Eldred Habert
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */



// Simple wrapper because document.getElementById is just ridiculous to type
function getElByID(id) {
    return document.getElementById(id);
}



// The main grunt.

const NDSARTools = {
    parseNumber: function(number, nbBits) {
        if(!/^(?:0x.+|0b[01]+|[1-9]+)$/i.test(number)) {
            throw new NDSARTools.ParseError("Cannot parse " + number + " as a number (NB: hexadecimal pseudo-numbers are accepted)");
        }

        let num = number;
        // Leave "0x" numbers as-is, even if they aren't proper numbers
        if(!/^0x/i.test(number)) {
            if(/^0b/i.test(number)) {
                num = parseInt(number.slice(2), 2);
            } else {
                num = parseInt(number);
            }
            num = num.toString(16);
        }
        
        // Remove "0x", remove trailing zeros, pad until the correct number of digits is reached
        num = num.slice(2).trimStart("0").padStart("0", nbBits / 4);
        if(num.length > nbBits / 4) {
            throw new NDSARTools.ParseError(number + " is too large for " + nbBits + " bits");
        }
        return num;
    },


    states: {
        CODE_BLOCK: 0,
        VALUES_BLOCK: 1
    },

    elemTypes: {
        WRITE_IMM32: 0,
        WRITE_IMM16: 1,
        WRITE_IMM8 : 2,
        IF_LT32    : 3,
        IF_GT32    : 4,
        IF_EQ32    : 5,
        IF_NE32    : 6,
        IF_LT16    : 7,
        IF_GT16    : 8,
        IF_EQ16    : 9,
        IF_NE16    : 10,
        LD_OFS_IND : 11,
        REPT_BLOCK : 12,
        EXTENDED   : 13,
        WRITE_VALS : 14,
        MEMCPY     : 15,

        isIf: function(type) {
            return type >= NDSARTools.elemTypes.IF_LT32 && type <= NDSARTools.elemTypes.IF_NE16;
        }
    },

    extendedTypes: {
        END_IF     : 0,
        END_REPT   : 1,
        END_ALL    : 2,
        LD_OFS_IMM : 3,
        ADD_STORED : 4,
        SET_STORED : 5,
        STORE_INC32: 6,
        STORE_INC16: 7,
        STORE_INC8 : 8,
        LD_STORED32: 9,
        LD_STORED16: 10,
        LD_STORED8 : 11,
        ADD_OFS32  : 12 // Undocumented, DC000000 YYYYYYYY <- added to ofs reg
        // All remaining types are invalid.
    },

    ParseError: function(message, line) {
        this.message = message;
        this.line = line;

        this.toString = function() {
            return "Line " + this.line + ": " + this.message;
        };
    },

    actionTypes: {
        ACTION_NOTHING: 0,
        ACTION_SIBLING: 1,
        ACTION_CHILD  : 2,
        ACTION_PARENT : 3,
        ACTION_ROOT   : 4
    },


    encodedTextarea: getElByID("arCode"),
    decodedTextarea: getElByID("pseudocode"),
    stdout:          getElByID("stdout"),

    optionFields: {
        "noQuestionMarks": "optQuestionMarks",
        "ignoreZeroRept": "optIgnoreZeroRept",
        "ignoreNoEndAll": "optIgnoreNoEndAll"
    },

    
    clearLog: function() {
        NDSARTools.stdout.innerHTML = "";
    },

    log: function(msg) {
        NDSARTools.stdout.innerHTML += msg + "<br />";
    },

    logMessage: function(msg) {
        NDSARTools.log(msg);
    },

    logWarning: function(msg) {
        NDSARTools.log("WARNING: " + msg);
    },

    logError: function(msg) {
        NDSARTools.log("ERROR: " + msg);
    },


    getEncodedCode: function() {
        return NDSARTools.encodedTextarea.value;
    },

    setEncodedCode: function(code) {
        NDSARTools.encodedTextarea.value = code;
    },

    getDecodedCode: function() {
        return NDSARTools.decodedTextarea.value;
    },

    setDecodedCode: function(code) {
        NDSARTools.decodedTextarea.value = code;
    },


    elemRegexes: [
        // Matches 32, 16 and 8-bit writes
        /^\[\s*(8|16|32)\s*:\s*(.+?)\s*\]\s*=\s*(.+?)$/i,
        // Matches 32- and 16-bit comparisons
        /^if\s*(.+?)\s*(<|>|==|!=)\s*(.+?)$/i,
        // Matches offset setting
        /^(?:offset|ofs)\s*=\s*\[\s*32\s*:\s*(.+?)\s*\]$/i,
        // Matches rept
        /^rept\s+(.+?)$/i,
        // Matches memory writes
        // TODO:
        // Matches memory copy
        /^copy\s+(.+?)\s+to\s+(.+?)$/i
    ],

    exElemRegexes: [
        // Matches block endings
        /^end(if|rept|all)$/i,
        // Matches immediate offset setting and adding
        /^(?:offset|ofs)\s*(\+?)=\s*(.+?)$/i,
        // Matches stored setting and adding
        /^stored\s*(\+?)=\s*\b([^[].+?)$/i,
        // Matches stored store (lol)
        /^\[\s*(8|16|32)\s*\+\s*:\s*(.+?)\s*\]\s*=\s*stored$/i,
        // Matches stored getting
        /^stored\s*=\s*\[\s*(8|16|32)+\s*:\s*(.+?)\s*\]$/i
    ],

    encodeLine: function(line, current, state, lineID, options) {
        line = line.trim();

        let action = NDSARTools.actionTypes.ACTION_SIBLING,
            type, matches;
        
        for(const i in NDSARTools.elemRegexes) {
            matches = line.match(NDSARTools.elemRegexes[i]);
            if(matches) {
                type = parseInt(i);
                break;
            }
        }

        if(!matches) {
            current.type = NDSARTools.elemTypes.EXTENDED;

            for(const i in NDSARTools.exElemRegexes) {
                matches = line.match(NDSARTools.exElemRegexes[i]);
                if(matches) {
                    type = parseInt(i);
                    break;
                }
            }

            if(!matches) {
                throw new NDSARTools.ParseError("Couldn't determine operation type (syntax error)", lineID);
            }

            switch(type) {
            case 0:
                // Block endings
                switch(matches[1].toLowerCase()) {
                case "if":
                    if(current.parent.parent === null || !NDSARTools.elemTypes.isIf(current.parent.type)) {
                        throw new NDSARTools.ParseError("Encountered ENDIF without being in IF", lineID);
                    }
                    current.exType = NDSARTools.extendedTypes.END_IF;
                    action = NDSARTools.actionTypes.ACTION_PARENT;
                    break;
                
                case "rept":
                    if(current.parent.parent === null || current.parent.type != NDSARTools.elemTypes.REPT_BLOCK) {
                        throw new NDSARTools.ParseError("Encountered ENDREPT without being in REPT", lineID);
                    }
                    current.exType = NDSARTools.extendedTypes.END_REPT;
                    action = NDSARTools.actionTypes.ACTION_PARENT;
                    break;

                case "all":
                    if(current.parent.parent === null) {
                        throw new NDSARTools.ParseError("Encountered ENDALL without being in anything.", lineID);
                    }
                    current.exType = NDSARTools.extendedTypes.END_ALL;
                    action = NDSARTools.actionTypes.ACTION_ROOT;
                    break;
                }
                break;

            case 1:
                // Immediate offset ops
                current.exType = matches[1] ? NDSARTools.extendedTypes.ADD_OFS32 : NDSARTools.extendedTypes.LD_OFS_IMM;
                try {
                    current.val = NDSARTools.parseNumber(matches[2], 32);
                } catch(error) {
                    if(error instanceof NDSARTools.ParseError) {
                        error.line = lineID;
                    }
                    throw error;
                }
                break;

            case 2:
                // Stored setting/adding
                current.exType = matches[1] ? NDSARTools.extendedTypes.ADD_STORED : NDSARTools.extendedTypes.SET_STORED;
                try {
                    current.val = NDSARTools.parseNumber(matches[2], 32);
                } catch(error) {
                    if(error instanceof NDSARTools.ParseError) {
                        error.line = lineID;
                    }
                    throw error;
                }
                break;
            
            case 3:
                // Stored storing
                current.exType = NDSARTools.extendedTypes.STORE_INC32 + ["32", "16", "8"].indexOf(matches[1]);
                matches = /^(?:offset|ofs)(?:\s*\+\s*(.+?)\s*)?$/.exec(matches[2]);
                if(!matches) {
                    throw new NDSARTools.ParseError("Left operand to stored stores must be an offset-relative pointer", lineID);
                }
                current.loc = 0;
                if(matches[2]) {
                    try {
                        current.loc = parseInt(matches[2]);
                    } catch(error) {
                        if(error instanceof NDSARTools.ParseError) {
                            error.line = lineID;
                        }
                        throw error;
                    }
                }
                break;

            case 4:
                // Stored getting
                current.exType = NDSARTools.extendedTypes.LD_STORED32 + ["32", "16", "8"].indexOf(matches[1]);
                matches = /^(?:offset|ofs)(?:\s*\+\s*(.+?)\s*)?$/.exec(matches[2]);
                if(!matches) {
                    throw new NDSARTools.ParseError("Left operand to stored gets must be an offset-relative pointer", lineID);
                }
                current.loc = 0;
                if(matches[1]) {
                    try {
                        current.loc = NDSARTools.parseNumber(matches[1]);
                    } catch(error) {
                        if(error instanceof NDSARTools.ParseError) {
                            error.line = lineID;
                        }
                        throw error;
                    }
                }
                break;
            }
        } else {
            switch(type) {
            case 0:
                // 32, 16 and 8-bit writes
                current.type = NDSARTools.elemTypes.WRITE_IMM32 + ["32", "16", "8"].indexOf(matches[1]);
                try {
                    current.val = NDSARTools.parseNumber(matches[3]);

                    matches = /^(?:offset|ofs)(?:\s*\+\s*(.+?))?$/.exec(matches[2]);
                    if(!matches) {
                        throw new NDSARTools.ParseError("Left operand to immediate write must be an offset-relative pointer!");
                    }
                    current.loc = 0;
                    if(matches[1]) {
                        current.loc = NDSARTools.parseNumber(matches[1]);
                    }
                } catch(error) {
                    if(error instanceof NDSARTools.ParseError) {
                        error.line = lineID;
                    }
                    throw error;
                }
                break;
            
            case 1:
                // 32- and 16-bit comparisons
                // One of those is a pointer, let's find out which one
                { // Needed for ESLint to not complain about declaring a variable inside a `case`
                    current.type = ["<", ">", "==", "!="].indexOf(matches[2]);
                    let ptrRegex = /^(?:\[\s*32\s*:\s*(.+?)\s*\]|\[\s*16\s*:\s*(.+?)\s*\](?:\s*&\s*(~)?\s*(.+))?)$/i,
                        ptrMatches = ptrRegex.exec(matches[1]),
                        ptrMatch;
                    if(!ptrMatches) {
                        // The pointer is the second element - we need to flip inequality signs if any, and also swap both matches
                        current.type ^= (current.type >> 1) ^ 1;
                        let tmp = matches[3];
                        matches[3] = matches[1];
                        matches[1] = tmp;
                        ptrMatches = ptrRegex.exec(matches[1]);
                        if(!ptrMatches) {
                            throw new NDSARTools.ParseError("One of the operands to If must be a pointer", lineID);
                        }
                    }

                    try {
                        if(ptrMatches[1] === undefined) {
                            // 16-bit comparison
                            current.type += NDSARTools.elemTypes.IF_LT16;
                            current.mask = ptrMatches[4] ? NDSARTools.parseNumber(ptrMatches[4]) : "0xFFFF"; // If the mask is unspecified, it defaults to none
                            if(!ptrMatches[3]) {
                                // The mask is stored inverted, so if it hasn't been inverted by the user, do it ourselves
                                if(/^[0-9A-F]{1,4}$/.test(current.mask)) {
                                    current.mask = (parseInt(current.mask, 16) ^ 0xFFFF).toString(16);
                                } else {
                                    throw new NDSARTools.ParseError("Masks are stored inverted, and can't automatically invert pseudo-values", lineID);
                                }
                            }
                            ptrMatch = ptrMatches[2];
                        } else {
                            // 32-bit comparison
                            current.type += NDSARTools.elemTypes.IF_LT32;
                            ptrMatch = ptrMatches[1];
                        }
                        current.loc = /^(offset|ofs)$/i.test(ptrMatch) ? 0 : NDSARTools.parseNumber(ptrMatch);
                        current.val = NDSARTools.parseNumber(matches[3]);
                    } catch(error) {
                        if(error instanceof NDSARTools.ParseError) {
                            error.line = lineID;
                        }
                        throw error;
                    }
                    action = NDSARTools.actionTypes.ACTION_CHILD;
                }
                break;
            
            case 2:
                // Offset setting
                current.type = NDSARTools.elemTypes.LD_OFS_IND;
                matches = /^(?:offset|ofs)(?:\s*\+\s*(.+?))$/.exec(matches[1]);
                current.loc = 0;
                if(matches[1]) {
                    try {
                        current.loc = NDSARTools.parseNumber(matches[1]);
                    } catch(error) {
                        if(error instanceof NDSARTools.ParseError) {
                            error.line = lineID;
                        }
                        throw error;
                    }
                }
                break;

            case 3:
                // Rept
                current.type = NDSARTools.elemTypes.REPT_BLOCK;
                try {
                    current.cnt = NDSARTools.parseNumber(matches[1]);
                } catch(error) {
                    if(error instanceof NDSARTools.ParseError) {
                        error.line = lineID;
                    }
                    throw error;
                }
                if(parseInt(current.cnt) === 0) {
                    if(!options.ignoreZeroRept) {
                        NDSARTools.logWarning("REPT with length zero isn't properly defined");
                    }
                } else {
                    action = NDSARTools.actionTypes.ACTION_CHILD;
                }
                break;

            case 4:
                // TODO: memory writes

            // case 5:
                // Memory copy
                current.type = NDSARTools.elemTypes.MEMCPY;
                try {
                    current.cnt = NDSARTools.parseNumber(matches[1]);
                    current.loc = NDSARTools.parseNumber(matches[2]);
                } catch(error) {
                    if(error instanceof NDSARTools.ParseError) {
                        error.line = lineID;
                    }
                    throw error;
                }
                break;
            }
        }

        return {action: action, state: state};
    },

    encodeStrings: [
        "0{7:loc} {8:val}",
        "1{7:loc} ????{4:val}",
        "2{7:loc} ??????{2:val}",
        "3{7:loc} {8:val}",
        "4{7:loc} {8:val}",
        "5{7:loc} {8:val}",
        "6{7:loc} {8:val}",
        "7{7:loc} {4:mask}{4:val}",
        "8{7:loc} {4:mask}{4:val}",
        "9{7:loc} {4:mask}{4:val}",
        "A{7:loc} {4:mask}{4:val}",
        "B{7:loc} ????????",
        "C??????? {8:cnt}",
        "EXTENDED", // Stub, there's special logic for extended codes
        "MEMORY WRITE", // TODO:
        "F{7:loc} {8:cnt}"
    ],
    exEncodestrings: [
        "D0?????? ????????",
        "D1?????? ????????",
        "D2?????? ????????",
        "D3?????? {8:val}",
        "D4?????? {8:val}",
        "D5?????? {8:val}",
        "D6?????? {8:loc}",
        "D7?????? {8:loc}",
        "D8?????? {8:loc}",
        "D9?????? {8:loc}",
        "DA?????? {8:loc}",
        "DB?????? {8:loc}",
        "DC?????? {8:val}"
    ],

    lenPropertyRegex: /\{([0-9]):([a-z]+)\}/i,

    encodeTree: function(tree, options) {
        let lines = [], lineID = 0;
        (function processTree(tree) {
            tree.children.forEach(elem => {
                let line, matches, filler, len;
                if(elem.type == NDSARTools.elemTypes.EXTENDED) {
                    line = NDSARTools.exEncodestrings[elem.exType];
                } else {
                    line = NDSARTools.encodeStrings[elem.type];
                }
                if(options.noQuestionMarks) {
                    line = line.replace(/\?/g, "0");
                }

                while((matches = line.match(NDSARTools.lenPropertyRegex))) {
                    len = parseInt(matches[1]);
                    filler = elem[matches[2]].toString(16).toUpperCase().trimStart("0").padStart(len, "0");
                    if(filler.length > len) {
                        throw new NDSARTools.ParseError("Number is too large", lineID);
                    }
                    line = line.replace(matches[0], filler);
                }
                lines.push(line);
                lineID++;

                if(elem.children) {
                    processTree(elem);
                }
                
            });
        })(tree);
        return lines;
    },


    decodeLine: function(line, current, state, lineID, options) {
        if(!/^\s*[^\s]{8}\s+[^\s]{8}\s*$/.test(line)) {
            throw new NDSARTools.ParseError("Lines must be in '01234567 89ABCDEF' format", lineID);
        }

        // Trim the line and remove all whitespace
        line = line.replace(/\s+/g, "");

        let action = NDSARTools.actionTypes.ACTION_SIBLING;

        // Depending on the current state...
        switch(state) {
        case NDSARTools.states.CODE_BLOCK:
            // Insert an element in the tree depending on type
            current.type = parseInt(line[0], 16);

            switch(parseInt(line[0], 16)) {
            case NDSARTools.elemTypes.IF_LT32:
            case NDSARTools.elemTypes.IF_GT32:
            case NDSARTools.elemTypes.IF_EQ32:
            case NDSARTools.elemTypes.IF_NE32:
                action = NDSARTools.actionTypes.ACTION_CHILD;

            case NDSARTools.elemTypes.WRITE_IMM32:
                current.loc  = line.slice(1, 8);
                current.val  = line.slice(8);
                break;

            case NDSARTools.elemTypes.IF_LT16:
            case NDSARTools.elemTypes.IF_GT16:
            case NDSARTools.elemTypes.IF_EQ16:
            case NDSARTools.elemTypes.IF_NE16:
                current.mask = line.slice(8, 12);
                action = NDSARTools.actionTypes.ACTION_CHILD;

            case NDSARTools.elemTypes.WRITE_IMM16:
                current.val  = line.slice(12);

            case NDSARTools.elemTypes.LD_OFS_IND:
                current.loc  = line.slice(1, 8);
                break;

            case NDSARTools.elemTypes.WRITE_IMM8:
                current.loc  = line.slice(1, 8);
                current.val  = line.slice(14);
                break;

            case NDSARTools.elemTypes.REPT_BLOCK:
                current.cnt  = line.slice(8);
                if(parseInt(current.cnt) !== 0) {
                    action = NDSARTools.actionTypes.ACTION_CHILD;
                } else if(!options.ignoreZeroRept) {
                    NDSARTools.logWarning("REPT with length zero isn't properly defined");
                }
                break;

            case NDSARTools.elemTypes.EXTENDED:
                current.exType = parseInt(line[1], 16);
                switch(parseInt(line[1], 16)) {
                case NDSARTools.extendedTypes.END_IF:
                    if(current.parent.parent === null || !NDSARTools.elemTypes.isIf(current.parent.type)) {
                        throw new NDSARTools.ParseError("Encountered ENDIF without being in IF", lineID);
                    }
                    action = NDSARTools.actionTypes.ACTION_PARENT;
                    break;

                case NDSARTools.extendedTypes.END_REPT:
                    if(current.parent.parent === null || current.parent.type != NDSARTools.elemTypes.REPT_BLOCK) {
                        throw new NDSARTools.ParseError("Encountered ENDR without being in REPT", lineID);
                    }
                    action = NDSARTools.actionTypes.ACTION_PARENT;
                    break;

                case NDSARTools.extendedTypes.END_ALL:
                    if(current.parent.parent === null) {
                        throw new NDSARTools.ParseError("Encountered ENDALL without being in anything.", lineID);
                    }
                    action = NDSARTools.actionTypes.ACTION_ROOT;
                    break;

                case NDSARTools.extendedTypes.LD_OFS_IMM:
                case NDSARTools.extendedTypes.ADD_STORED:
                case NDSARTools.extendedTypes.SET_STORED:
                case NDSARTools.extendedTypes.ADD_OFS32:
                    current.val = line.slice(8);
                    break;

                case NDSARTools.extendedTypes.STORE_INC32:
                case NDSARTools.extendedTypes.STORE_INC16:
                case NDSARTools.extendedTypes.STORE_INC8:
                case NDSARTools.extendedTypes.LD_STORED32:
                case NDSARTools.extendedTypes.LD_STORED16:
                case NDSARTools.extendedTypes.LD_STORED8:
                    current.loc = line.slice(8);
                    break;

                default:
                    throw new NDSARTools.ParseError("Invalid extended command type '" + line[1] + "'", lineID);
                }
                break;

            case NDSARTools.elemTypes.WRITE_VALS:
                state = NDSARTools.states.VALUES_BLOCK;
                action = NDSARTools.actionTypes.ACTION_NOTHING;
                current.loc = line.slice(1, 8);
                current.cnt = line.slice(8);
                current.values = [];
                if(parseInt(current.cnt, 16) === 0) {
                    throw new NDSARTools.ParseError("Value blocks cannot have zero values", lineID);
                }
                break;

            case NDSARTools.elemTypes.MEMCPY:
                current.loc = line.slice(1, 8);    
                current.cnt = line.slice(8);
                break;

            default:
                throw new NDSARTools.ParseError("Invalid command type '" + line[0] + "'", lineID);
            }
            break;

        case NDSARTools.states.VALUES_BLOCK:
            for(let i = 0; i < 8 && current.values.length < parseInt(current.cnt, 16); i++) {
                current.values.push(line.slice(-2));
                line = line.slice(0, -2);
            }
            if(current.values.length === parseInt(current.cnt, 16)) {
                state = NDSARTools.states.CODE_BLOCK;
                action = NDSARTools.actionTypes.ACTION_SIBLING;
            } else {
                action = NDSARTools.actionTypes.ACTION_NOTHING;
            }
            break;

        default:
            throw new RangeError("Line " + lineID + ": invalid state " + state);
        }

        // IF elements have a special case if the specified loc is zero
        if(NDSARTools.elemTypes.isIf(current.type)) {
            if(parseInt(current.loc, 16) === 0) {
                current.loc = "offset";
            } else {
                current.loc = "0x" + current.loc;
            }
        }

        return {action: action, state: state};
    },

    elemStrings: [
        "[32: offset + 0x{loc}] = 0x{val}",
        "[16: offset + 0x{loc}] = 0x{val}",
        "[ 8: offset + 0x{loc}] = 0x{val}",
        "If [32: {loc}] < 0x{val}",
        "If [32: {loc}] > 0x{val}",
        "If [32: {loc}] == 0x{val}",
        "If [32: {loc}] != 0x{val}",
        "If [16: {loc}] & ~0x{mask} < 0x{val}",
        "If [16: {loc}] & ~0x{mask} > 0x{val}",
        "If [16: {loc}] & ~0x{mask} == 0x{val}",
        "If [16: {loc}] & ~0x{mask} != 0x{val}",
        "offset = [32: offset + 0x{loc}]",
        "Rept 0x{cnt}",
        "EXTENDED", // Stub, since there's special logic for extended elements
        "MEMORY WRITES", // TODO:
        "Copy 0x{cnt} to 0x{loc}"
    ],

    exElemStrings: [
        "EndIf",
        "EndRept",
        "EndAll",
        "offset = 0x{val}",
        "stored += 0x{val}",
        "stored = 0x{val}",
        "[32+: ofs + 0x{loc}] = stored",
        "[16+: ofs + 0x{loc}] = stored",
        "[ 8+: ofs + 0x{loc}] = stored",
        "stored = [32: offset + 0x{loc}]",
        "stored = [16: offset + 0x{loc}]",
        "stored = [ 8: offset + 0x{loc}]",
        "offset += 0x{val}"
        // No more codes
    ],

    propertyRegex: /\{[a-z]+\}/gi,

    decodeTree: function(tree, options) {
        let lineID = 0; // Just in case there's any need to throw a ParseError...
        return (
            function decodeElems(elem, lines, indent) {
                elem.children.forEach(elem => {
                    lineID++;

                    let elemString = elem.type == NDSARTools.elemTypes.EXTENDED ? NDSARTools.exElemStrings[elem.exType] : NDSARTools.elemStrings[elem.type],
                        // List of all properties that needs replacement
                        propertyList = elemString.match(NDSARTools.propertyRegex) || [];
                    // Replace all property names in the string by their value in the object
                    propertyList.forEach(propName => { elemString = elemString.replace(propName, elem[propName.slice(1, -1)]); });
                    lines.push(indent + elemString);

                    if(typeof elem.children !== "undefined") {
                        lines = decodeElems(elem, lines, indent + "  ");
                    }
                });
                return lines;
            }
        )(tree, [], "");
    },


    performConversion: function(getterFunc, lineProcessor, treeProcessor, setterFunc) {
        try {
            NDSARTools.clearLog();
            NDSARTools.logMessage("Beginning...");

            let options = {};
            for(const optionName in NDSARTools.optionFields) {
                options[optionName] = getElByID(NDSARTools.optionFields[optionName]).checked;
            }

            const encodedCode = getterFunc().split("\n");
            let codeTree = {parent: null, children: []},
                state = NDSARTools.states.CODE_BLOCK,
                current = {parent: codeTree},
                lineID = 1,
                action;

            encodedCode.forEach(line => {
                let next = lineProcessor(line, current, state, lineID, options);
                action = next.action;
                state  = next.state;

                switch(action) {
                case NDSARTools.actionTypes.ACTION_SIBLING:
                    current.parent.children.push(current);
                    current = {parent: current.parent};
                    break;

                case NDSARTools.actionTypes.ACTION_CHILD:
                    current.children = [];
                    current.parent.children.push(current);
                    current = {parent: current};
                    break;

                case NDSARTools.actionTypes.ACTION_PARENT:
                    current.parent = current.parent.parent; // Go up one level
                    current.parent.children.push(current);
                    current = {parent: current.parent};
                    break;

                case NDSARTools.actionTypes.ACTION_ROOT:
                    current.parent = codeTree; // Go back to roots (hah!)
                    current.parent.children.push(current);
                    current = {parent: codeTree};
                    break;
                }

                lineID++;
            });
            if(codeTree.children.slice(-1)[0].exType !== NDSARTools.extendedTypes.END_ALL && !options.ignoreNoEndAll) {
                NDSARTools.logWarning("Code does not end with an EndAll operation");
            }
            NDSARTools.logMessage("Finished building tree.");
            
            setterFunc(treeProcessor(codeTree, options).join("\n"));
            NDSARTools.logMessage("Operation successful!");
        } catch(error) {
            if(error instanceof NDSARTools.ParseError) {
                NDSARTools.logError("Parsing failed: " + error.toString());
            } else {
                NDSARTools.logWarning("AN INTERNAL ERROR HAS OCCURRED.");
                NDSARTools.logWarning("This isn't supposed to happen.");
                NDSARTools.logWarning("Please copy the following text to the developer,");
                NDSARTools.logWarning("along with what you were trying to convert.");
                NDSARTools.logWarning("Please avoid screenshots.");
                NDSARTools.logError(error.name + ": " + error.message);
                NDSARTools.logError("At " + error.fileName + ", line " + error.lineNumber + ", col " + error.columnNumber);
                NDSARTools.logError("Stack trace:");
                error.stack.split("\n").forEach(line => {
                    if(line.trim() != "") {
                        NDSARTools.logError("\t" + line.trim());
                    }
                });

                // Although it's probably pretty pointless, still rethrow the error
                throw error;
            }
        }
    },

    performEncoding: function() {
        NDSARTools.performConversion(NDSARTools.getDecodedCode, NDSARTools.encodeLine, NDSARTools.encodeTree, NDSARTools.setEncodedCode);
    },

    performDecoding: function() {
        NDSARTools.performConversion(NDSARTools.getEncodedCode, NDSARTools.decodeLine, NDSARTools.decodeTree, NDSARTools.setDecodedCode);
    }
};

getElByID("btnEncode").addEventListener("click", NDSARTools.performEncoding);
getElByID("btnDecode").addEventListener("click", NDSARTools.performDecoding);
