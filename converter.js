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

// Remove all whitespace from a string, in multiple iterations
// Required because somehow sometimes only one instance is removed
function removeWhitespace(str) {
    let oldStr;
    do {
        oldStr = str;
        str = oldStr.replace(/\s+/, "");
    } while(str !== oldStr);
    return str;
}

// Turns a string hex digit into the corresponding integer (in range 0 through 15)
function getHexDigit(hexDigit) {
    return "0123456789ABCDEF".indexOf(hexDigit);
}

const NDSARTools = {
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
        SET_STORED : 4,
        ADD_STORED : 5,
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
        this.message = "Line " + line + ": " + message;
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
        /^\[\s*(8|16|32)\s*:\s*(?:ofs|offset)\s*(\+\s*0x[0-9A-F]+)\s*\]\s*=\s*0x[0-9A-F]+$/i
        // TODO:
    ],

    elemStrings: [
        "[32:ofs+0x{loc}] = 0x{val}",
        "[16:ofs+0x{loc}] = 0x{val}",
        "[ 8:ofs+0x{loc}] = 0x{val}",
        "If [32:{loc}] < 0x{val}",
        "If [32:{loc}] > 0x{val}",
        "If [32:{loc}] == 0x{val}",
        "If [32:{loc}] != 0x{val}",
        "If [16:{loc}] & 0x{mask} < 0x{val}",
        "If [16:{loc}] & 0x{mask} > 0x{val}",
        "If [16:{loc}] & 0x{mask} == 0x{val}",
        "If [16:{loc}] & 0x{mask} != 0x{val}",
        "ofs = [ofs+0x{loc}]",
        "Rept {cnt}",
        "EXTENDED", // Stub, since there's special logic for extended elements
        "MEMORY WRITES", // TODO:
        "Copy 0x{cnt} to 0x{loc}"
    ],

    exElemStrings: [
        "EndIf",
        "EndRept",
        "EndAll",
        "ofs = 0x{val}",
        "stored += 0x{val}",
        "stored = 0x{val}",
        "[32+:ofs+0x{loc}] = stored",
        "[16+:ofs+0x{loc}] = stored",
        "[ 8+:ofs+0x{loc}] = stored",
        "stored = [32:ofs+0x{loc}]",
        "stored = [16:ofs+0x{loc}]",
        "stored = [ 8:ofs+0x{loc}]",
        "offset += 0x{val}"
        // No more codes
    ],

    propertyRegex: /\{[a-z]+\}/gi,

    decodeTree: function(tree) {
        let lineID = 0; // Just in case there's any need to throw a ParseError...
        return (
            function decodeElems(elemList, lines, indent) {
                elemList.forEach(elem => {
                    lineID++;

                    let elemString = elem.type == NDSARTools.elemTypes.EXTENDED ? NDSARTools.exElemStrings[elem.exType] : NDSARTools.elemStrings[elem.type],
                        // List of all properties that needs replacement
                        propertyList = elemString.match(NDSARTools.propertyRegex) || [];
                    // Replace all propetry names in the string by their value in the object
                    propertyList.forEach(propName => { elemString = elemString.replace(propName, elem[propName.slice(1, -1)]); });
                    lines.push(indent + elemString);

                    if(typeof elem.children !== "undefined") {
                        lines = decodeElems(elem.children, lines, indent + "  ");
                    }
                });
                return lines;
            }
        )(tree, [], "");
    },

    encodeTree: function(tree) {
        // TODO:
    },

    performEncoding: function() {
        NDSARTools.clearLog();
        // TODO:
        NDSARTools.logError("Not implemented yet.");
    },

    performDecoding: function() {
        try {
            NDSARTools.clearLog();
            NDSARTools.logMessage("Beginning decoding...");

            const encodedCode = NDSARTools.getEncodedCode().split("\n");
            let codeTree = [],
                state = NDSARTools.states.CODE_BLOCK,
                current = {parent: codeTree},
                lineID = 1,
                action;

            encodedCode.forEach(line => {
                // Trim the line and remove all whitespace
                line = removeWhitespace(line);

                action = NDSARTools.actionTypes.ACTION_SIBLING;
                // Depending on the current state...
                switch(state) {
                case NDSARTools.states.CODE_BLOCK:
                    // Insert an element in the tree depending on type
                    current.type = getHexDigit(line[0]);
                    switch(getHexDigit(line[0])) {
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
                        action = NDSARTools.actionTypes.ACTION_CHILD;
                        break;

                    case NDSARTools.elemTypes.EXTENDED:
                        current.exType = getHexDigit(line[1]);
                        switch(getHexDigit(line[1])) {
                        case NDSARTools.extendedTypes.END_IF:
                            if(current.parent == codeTree || !NDSARTools.elemTypes.isIf(current.parent.type)) {
                                throw new NDSARTools.ParseError("Encountered ENDIF without being in IF", lineID);
                            }
                            action = NDSARTools.actionTypes.ACTION_PARENT;
                            break;

                        case NDSARTools.extendedTypes.END_REPT:
                            if(current.parent == codeTree || current.parent.type != NDSARTools.elemTypes.REPT_BLOCK) {
                                throw new NDSARTools.ParseError("Encountered ENDR without being in REPT", lineID);
                            }
                            action = NDSARTools.actionTypes.ACTION_PARENT;
                            break;

                        case NDSARTools.extendedTypes.END_ALL:
                            if(current.parent == null) {
                                throw new NDSARTools.ParseError("Encountered ENDALL without being in anything.", lineID);
                            }
                            action = NDSARTools.actionTypes.ACTION_ROOT;
                            break;

                            // TODO:

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

                switch(action) {
                case NDSARTools.actionTypes.ACTION_SIBLING:
                    current.parent.push(current);
                    current = {parent: current.parent};
                    break;

                case NDSARTools.actionTypes.ACTION_CHILD:
                    current.children = [];
                    current.parent.push(current);
                    current = {parent: current.children};
                    break;

                case NDSARTools.actionTypes.ACTION_PARENT:
                    current.parent = current.parent.parent; // Go up one level
                    current.parent.push(current);
                    current = {parent: current.parent};
                    break;

                case NDSARTools.actionTypes.ACTION_ROOT:
                    current.parent = codeTree; // Go back to roots (hah!)
                    current.parent.push(current);
                    current = {parent: codeTree};
                    break;
                }

                lineID++;
            });
            NDSARTools.logMessage("Finished building tree.");
            
            NDSARTools.setDecodedCode(NDSARTools.decodeTree(codeTree).join("\n"));
            NDSARTools.logMessage("Decoding successful!");
        } catch(error) {
            if(error instanceof NDSARTools.ParseError) {
                NDSARTools.logError("Parsing failed: " + error.message);
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
    }
};

getElByID("btnEncode").addEventListener("click", NDSARTools.performEncoding);
getElByID("btnDecode").addEventListener("click", NDSARTools.performDecoding);
