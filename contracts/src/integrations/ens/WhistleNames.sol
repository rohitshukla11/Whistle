// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

/// @title WhistleNames
/// @notice DNS wire-format encoding, namehash, and small string helpers.
/// @dev ENSv2 setters and `resolve()` take DNS-ENCODED names (`packetToBytes`
///      form), not namehashes — see the Permissioned Resolver docs. Encoding is
///      done once per agent at creation and stored, because it is static for the
///      life of the name and rebuilding it on every authorization check would be
///      pure waste.
library WhistleNames {
    error LabelTooLong();
    error EmptyLabel();
    error NotANumber();

    /// @notice DNS wire format: each label length-prefixed, terminated by a zero byte.
    /// @dev ["agent-1","alice","whistle","eth"]
    ///      -> 0x07"agent-1"0x05"alice"0x07"whistle"0x03"eth"0x00
    function dnsEncode(string[] memory labels) internal pure returns (bytes memory out) {
        for (uint256 i = 0; i < labels.length; ++i) {
            bytes memory l = bytes(labels[i]);
            if (l.length == 0) revert EmptyLabel();
            if (l.length > 255) revert LabelTooLong();
            out = abi.encodePacked(out, uint8(l.length), l);
        }
        out = abi.encodePacked(out, uint8(0));
    }

    /// @notice ENS namehash, computed right to left from the TLD.
    function namehash(string[] memory labels) internal pure returns (bytes32 node) {
        for (uint256 i = labels.length; i > 0; --i) {
            node = keccak256(abi.encodePacked(node, keccak256(bytes(labels[i - 1]))));
        }
    }

    /// @notice Human-readable dotted name, for events and records.
    function join(string[] memory labels) internal pure returns (string memory out) {
        for (uint256 i = 0; i < labels.length; ++i) {
            out = i == 0 ? labels[i] : string.concat(out, ".", labels[i]);
        }
    }

    /// @notice Decimal string -> uint256. Empty string is 0.
    /// @dev Spend caps live in ENS as human-readable text records so the agent
    ///      profile page proves they are real, which means the authorization path
    ///      has to parse one. Rejects any non-digit rather than silently truncating.
    function parseUint(string memory s) internal pure returns (uint256 value) {
        bytes memory b = bytes(s);
        for (uint256 i = 0; i < b.length; ++i) {
            uint8 c = uint8(b[i]);
            if (c < 0x30 || c > 0x39) revert NotANumber();
            value = value * 10 + (c - 0x30);
        }
    }

    /// @notice uint256 -> decimal string.
    function toString(uint256 v) internal pure returns (string memory) {
        if (v == 0) return "0";
        uint256 digits;
        for (uint256 t = v; t != 0; t /= 10) ++digits;
        bytes memory buf = new bytes(digits);
        while (v != 0) {
            buf[--digits] = bytes1(uint8(48 + (v % 10)));
            v /= 10;
        }
        return string(buf);
    }
}
