#!/bin/bash

# Script to fetch content from a URL and save it to a specified location

set -e

# Check if required arguments are provided
if [ $# -lt 2 ]; then
    echo "Usage: $0 <url> <output_path>"
    echo "  <url>         - The URL to fetch content from"
    echo "  <output_path> - The path where the content should be saved"
    exit 1
fi

URL="$1"
OUTPUT_PATH="$2"

# Create the directory if it doesn't exist
OUTPUT_DIR=$(dirname "$OUTPUT_PATH")
if [ ! -d "$OUTPUT_DIR" ]; then
    mkdir -p "$OUTPUT_DIR"
fi

# Fetch the content and save it
echo "Fetching content from: $URL"
curl -fsSL "$URL" -o "$OUTPUT_PATH"

echo "Content saved to: $OUTPUT_PATH"
