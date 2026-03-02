"""
Utility for converting MCP tool schemas to Google Gemini-compatible format.

MCP uses JSON Schema 2020-12 which includes metadata fields like $schema and
additionalProperties. Google Gemini's FunctionDeclaration API uses a stricter
subset of JSON Schema and rejects these fields during client-side validation.

This module provides conversion functions to clean MCP schemas for use with Gemini.
"""

from typing import Any, Dict


def convert_mcp_schema_to_gemini(schema: Dict[str, Any]) -> Dict[str, Any]:
    """
    Convert an MCP tool inputSchema to Gemini-compatible format.

    Removes fields that are not supported by Gemini's FunctionDeclaration:
    - $schema: JSON Schema version metadata
    - additionalProperties: Property validation control

    Args:
        schema: The MCP tool's inputSchema dictionary

    Returns:
        A cleaned schema dictionary compatible with Gemini's FunctionDeclaration

    Example:
        >>> mcp_schema = {
        ...     "$schema": "https://json-schema.org/draft/2020-12/schema",
        ...     "type": "object",
        ...     "properties": {"name": {"type": "string"}},
        ...     "additionalProperties": False
        ... }
        >>> gemini_schema = convert_mcp_schema_to_gemini(mcp_schema)
        >>> # Result: {"type": "object", "properties": {"name": {"type": "string"}}}
    """
    if not isinstance(schema, dict):
        return schema

    # Fields that Gemini's FunctionDeclaration doesn't support
    UNSUPPORTED_FIELDS = {"$schema", "additionalProperties"}

    # Create a new cleaned schema
    cleaned_schema = {}

    for key, value in schema.items():
        # Skip unsupported fields
        if key in UNSUPPORTED_FIELDS:
            continue

        # Recursively clean nested schemas
        if isinstance(value, dict):
            cleaned_schema[key] = convert_mcp_schema_to_gemini(value)
        elif isinstance(value, list):
            cleaned_schema[key] = [
                convert_mcp_schema_to_gemini(item) if isinstance(item, dict) else item
                for item in value
            ]
        else:
            cleaned_schema[key] = value

    return cleaned_schema


def convert_mcp_schema_to_anthropic(schema: Dict[str, Any]) -> Dict[str, Any]:
    """
    Convert an MCP tool inputSchema to Anthropic-compatible input_schema format.

    Anthropic's tool input_schema accepts the same JSON Schema subset as Gemini
    (type, properties, required, etc.), so we reuse the Gemini cleaner.
    """
    return convert_mcp_schema_to_gemini(schema)


def convert_mcp_schema_to_openai(schema: Dict[str, Any]) -> Dict[str, Any]:
    """
    Convert an MCP tool inputSchema to OpenAI function-calling parameters format.

    OpenAI's function calling uses the same JSON Schema subset (type, properties,
    required, etc.), so we reuse the Gemini cleaner.
    """
    return convert_mcp_schema_to_gemini(schema)
