/**
 * Recipe extraction utility for parsing Minecraft crafting recipes from wiki content
 */
import * as cheerio from 'cheerio';

export interface RecipeIngredient {
  item: string;
  quantity: number;
}

export interface CraftingRecipe {
  ingredients: RecipeIngredient[];
  pattern?: string | string[][];
  recipe_type: 'shaped' | 'shapeless' | 'smelting' | 'brewing' | 'unknown';
  result?: {
    item: string;
    quantity: number;
  };
}

export interface RecipeExtractionResult {
  title: string;
  crafting_recipe?: CraftingRecipe;
  hasRecipe: boolean;
  sectionIndex?: number;
  content: string;
}

/**
 * Extract crafting recipe information from wiki content
 */
export function extractCraftingRecipe(content: string, title: string, sectionIndex?: number): RecipeExtractionResult {
  const result: RecipeExtractionResult = {
    title,
    hasRecipe: false,
    content,
    sectionIndex
  };

  // Check if this is likely a crafting section
  if (!isCraftingSection(content)) {
    return result;
  }

  try {
    const recipe = parseCraftingRecipe(content);
    if (recipe) {
      result.crafting_recipe = recipe;
      result.hasRecipe = true;
    }
  } catch {
    // If parsing fails, continue without recipe data
    // Silently ignore parsing errors in production
  }

  return result;
}

/**
 * Check if the content appears to contain crafting recipe information
 */
function isCraftingSection(content: string): boolean {
  const craftingIndicators = [
    /crafting/i,
    /recipe/i,
    /ingredients/i,
    /{{[^}]*craft[^}]*}}/i, // MediaWiki crafting templates
    /<table[^>]*craft/i,
    /\|\s*[A-Za-z\s]+\s*\|\s*\d+/,  // Table format with quantities
    /<table[\s\S]*?ingredient[\s\S]*?<\/table>/i, // HTML table with ingredient column
    /<table[\s\S]*?quantity[\s\S]*?<\/table>/i, // HTML table with quantity column
    /<tr[\s\S]*?<td[\s\S]*?\d+[\s\S]*?<\/td>/i, // Table row with numeric values
    /\d+\s+[A-Za-z\s]+/,  // Pattern like "3 Obsidian" or "5 Glass"
    /mcui-input/i, // MCUI HTML structure
    /mcui-row/i, // MCUI row structure
    /invslot/i, // Inventory slot structure
    /data-minetip-title/i, // MCUI item tooltip data
  ];

  return craftingIndicators.some(indicator => indicator.test(content));
}

/**
 * Parse crafting recipe from wiki content
 */
function parseCraftingRecipe(content: string): CraftingRecipe | null {
  // Try different parsing strategies in order of specificity
  const recipe = parseFromMcuiHtml(content) ||
                 parseFromTemplate(content) || 
                 parseFromTable(content) || 
                 parseFromText(content);

  return recipe;
}

/**
 * Parse recipe from Minecraft Wiki MCUI HTML structure using cheerio
 */
function parseFromMcuiHtml(content: string): CraftingRecipe | null {
  try {
    const $ = cheerio.load(content);
    
    // Look for the main crafting container
    const craftingContainer = $('.mcui-input, .mcui-crafting').first();
    if (craftingContainer.length === 0) {
      return null;
    }

    const ingredientCounts: Map<string, number> = new Map();
    const pattern: string[][] = [
      ['', '', ''],
      ['', '', ''],
      ['', '', '']
    ];

    // Parse MCUI crafting grids with precise slot positioning
    const rows = craftingContainer.find('.mcui-row, .mcui-slot-row');
    
    rows.each((rowIndex, row) => {
      if (rowIndex >= 3) return; // Only handle 3x3 grid
      
      const slots = $(row).find('.invslot, .mcui-slot');
      slots.each((colIndex, slot) => {
        if (colIndex >= 3) return; // Only handle 3 columns
        
        const itemName = extractItemName($(slot));
        if (itemName) {
          pattern[rowIndex][colIndex] = itemName;
          const currentCount = ingredientCounts.get(itemName) || 0;
          ingredientCounts.set(itemName, currentCount + 1);
        }
      });
    });

    // If no rows found, try flat slot approach (some wiki pages use different structure)
    if (rows.length === 0) {
      const allSlots = craftingContainer.find('.invslot, .mcui-slot');
      allSlots.each((index, slot) => {
        if (index >= 9) return; // Max 9 slots in 3x3 grid
        
        const itemName = extractItemName($(slot));
        if (itemName) {
          const row = Math.floor(index / 3);
          const col = index % 3;
          if (row < 3 && col < 3) {
            pattern[row][col] = itemName;
            const currentCount = ingredientCounts.get(itemName) || 0;
            ingredientCounts.set(itemName, currentCount + 1);
          }
        }
      });
    }

    // Convert to ingredients array
    const ingredients: RecipeIngredient[] = [];
    for (const [item, quantity] of ingredientCounts) {
      ingredients.push({ item, quantity });
    }

    return ingredients.length > 0 ? {
      ingredients,
      pattern,
      recipe_type: 'shaped',
    } : null;
    
  } catch (error) {
    // If cheerio parsing fails, return null
    return null;
  }
}

/**
 * Extract item name from various slot elements using multiple strategies
 */
function extractItemName(slot: any): string | null {
  // Strategy 1: data-minetip-title attribute (most reliable)
  const minetipTitle = slot.find('[data-minetip-title]').first().attr('data-minetip-title') ||
                       slot.attr('data-minetip-title');
  if (minetipTitle) {
    const cleaned = cleanItemName(decodeHtmlEntities(minetipTitle));
    if (isValidItemName(cleaned)) return cleaned;
  }

  // Strategy 2: Link title attribute
  const linkTitle = slot.find('a').first().attr('title');
  if (linkTitle) {
    const cleaned = cleanItemName(decodeHtmlEntities(linkTitle));
    if (isValidItemName(cleaned)) return cleaned;
  }

  // Strategy 3: Image alt text
  const imgAlt = slot.find('img').first().attr('alt');
  if (imgAlt) {
    const cleaned = cleanItemName(decodeHtmlEntities(imgAlt));
    if (isValidItemName(cleaned)) return cleaned;
  }

  // Strategy 4: Link text content
  const linkText = slot.find('a').first().text().trim();
  if (linkText) {
    const cleaned = cleanItemName(linkText);
    if (isValidItemName(cleaned)) return cleaned;
  }

  // Strategy 5: Direct text content (fallback)
  const textContent = slot.text().trim();
  if (textContent) {
    const cleaned = cleanItemName(textContent);
    if (isValidItemName(cleaned)) return cleaned;
  }

  return null;
}

/**
 * Decode HTML entities in text
 */
function decodeHtmlEntities(text: string): string {
  const entities: Record<string, string> = {
    '&amp;': '&',
    '&lt;': '<',
    '&gt;': '>',
    '&quot;': '"',
    '&#39;': "'",
    '&nbsp;': ' '
  };
  
  return text.replace(/&[#\w]+;/g, (entity) => entities[entity] || entity);
}

/**
 * Parse recipe from MediaWiki crafting templates with better validation
 */
function parseFromTemplate(content: string): CraftingRecipe | null {
  try {
    // Look for common crafting templates like {{Crafting Table}} or {{Recipe}}
    const templateRegex = /{{[^}]*(?:craft|recipe)[^}]*\|([^}]+)}}/gi;
    const matches = content.match(templateRegex);

    if (!matches) return null;

    const ingredients: RecipeIngredient[] = [];
    let recipeType: 'shaped' | 'shapeless' | 'smelting' | 'brewing' | 'unknown' = 'shaped';

    for (const match of matches) {
      // Extract parameters from template
      const params = match.split('|').slice(1);
      
      for (const param of params) {
        const trimmed = param.trim();
        
        // Look for ingredient specifications like "A1=Nautilus Shell" or "item=8 Nautilus Shell"
        const ingredientMatch = trimmed.match(/^(?:[A-Z]\d|item|ingredient\d*)\s*=\s*(?:(\d+)\s*)?([^|}]+)$/i);
        if (ingredientMatch) {
          const quantity = ingredientMatch[1] ? parseInt(ingredientMatch[1]) : 1;
          const itemText = ingredientMatch[2];
          
          // Extract quantity from item text if not found in quantity field
          const textQuantity = extractQuantityFromText(itemText);
          const finalQuantity = textQuantity || quantity;
          
          const item = cleanItemName(itemText);
          
          if (item && isValidItemName(item)) {
            // Check if ingredient already exists and update quantity
            const existingIngredient = ingredients.find(ing => ing.item === item);
            if (existingIngredient) {
              existingIngredient.quantity += finalQuantity;
            } else {
              ingredients.push({ item, quantity: finalQuantity });
            }
          }
        }
        
        // Check for shapeless indicator
        if (trimmed.toLowerCase().includes('shapeless')) {
          recipeType = 'shapeless';
        }
      }
    }

    if (ingredients.length === 0) return null;

    return {
      ingredients,
      recipe_type: recipeType,
      pattern: recipeType === 'shaped' ? 'Arranged in crafting grid' : undefined
    };
    
  } catch (error) {
    return null;
  }
}

/**
 * Parse recipe from HTML table format using cheerio
 */
function parseFromTable(content: string): CraftingRecipe | null {
  try {
    const $ = cheerio.load(content);
    const ingredients: RecipeIngredient[] = [];
    
    // Look for tables that might contain recipe information
    const tables = $('table');
    
    tables.each((_, table) => {
      const rows = $(table).find('tr');
      
      rows.each((rowIndex, row) => {
        const cells = $(row).find('td, th');
        
        // Skip header rows
        if (rowIndex === 0) {
          const headerText = $(row).text().toLowerCase();
          if (headerText.includes('ingredient') || headerText.includes('item') || headerText.includes('quantity')) {
            return; // Skip this row
          }
        }
        
        if (cells.length >= 2) {
          // Extract item and quantity from table cells
          const cell1Text = $(cells[0]).text().trim();
          const cell2Text = $(cells[1]).text().trim();
          
          // Try to determine which cell contains the item and which contains quantity
          const quantity1 = extractQuantityFromText(cell1Text);
          const quantity2 = extractQuantityFromText(cell2Text);
          
          let itemName: string | null = null;
          let quantity = 1;
          
          if (quantity2 && !quantity1) {
            // Cell 1 is item, cell 2 is quantity
            itemName = cleanItemName(cell1Text);
            quantity = quantity2;
          } else if (quantity1 && !quantity2) {
            // Cell 1 is quantity, cell 2 is item
            itemName = cleanItemName(cell2Text);
            quantity = quantity1;
          } else {
            // Try to extract quantity from first cell text
            const quantityFromCell1 = extractQuantityFromText(cell1Text);
            if (quantityFromCell1) {
              itemName = cleanItemName(cell1Text.replace(/\d+\s*[×x]?\s*/, ''));
              quantity = quantityFromCell1;
            } else {
              // Default: treat first cell as item
              itemName = cleanItemName(cell1Text);
              quantity = extractQuantityFromText(cell2Text) || 1;
            }
          }
          
          if (itemName && isValidItemName(itemName)) {
            // Check if ingredient already exists
            const existingIngredient = ingredients.find(ing => ing.item === itemName);
            if (existingIngredient) {
              existingIngredient.quantity += quantity;
            } else {
              ingredients.push({ item: itemName, quantity });
            }
          }
        }
      });
    });

    return ingredients.length > 0 ? {
      ingredients,
      recipe_type: 'shaped',
      pattern: 'Crafting table arrangement'
    } : null;
    
  } catch (error) {
    return null;
  }
}

/**
 * Parse recipe from plain text format and list-based ingredient lists
 */
function parseFromText(content: string): CraftingRecipe | null {
  try {
    const $ = cheerio.load(content);
    const ingredients: RecipeIngredient[] = [];

    // Strategy 1: Parse ingredient lists (ul, ol elements)
    const listItems = $('ul li, ol li');
    listItems.each((_, item) => {
      const text = $(item).text().trim();
      const quantity = extractQuantityFromText(text);
      const itemName = cleanItemName(text);
      
      if (itemName && isValidItemName(itemName)) {
        const existingIngredient = ingredients.find(ing => ing.item === itemName);
        if (existingIngredient) {
          existingIngredient.quantity += (quantity || 1);
        } else {
          ingredients.push({ item: itemName, quantity: quantity || 1 });
        }
      }
    });

    // Strategy 2: Parse patterns like "8 Nautilus Shell + 1 Heart of the Sea"
    if (ingredients.length === 0) {
      const ingredientPattern = /(\d+)\s+([A-Za-z\s]+?)(?:\s*(?:\+|and|,)|$)/gi;
      let match;

      while ((match = ingredientPattern.exec(content)) !== null) {
        const quantity = parseInt(match[1]);
        const item = cleanItemName(match[2]);

        if (item && isValidItemName(item) && quantity > 0) {
          const existingIngredient = ingredients.find(ing => ing.item === item);
          if (existingIngredient) {
            existingIngredient.quantity += quantity;
          } else {
            ingredients.push({ item, quantity });
          }
        }
      }
    }

    // Strategy 3: Look for simple ingredient lists in text
    if (ingredients.length === 0) {
      const simplePattern = /(?:ingredients?[:\s]*|recipe[:\s]*|materials?[:\s]*)(.*?)(?:\n|$)/i;
      const simpleMatch = content.match(simplePattern);
      
      if (simpleMatch) {
        const ingredientText = simpleMatch[1];
        const items = ingredientText
          .split(/[+&,]/)
          .map(item => {
            const quantity = extractQuantityFromText(item);
            const cleanedItem = cleanItemName(item);
            return { item: cleanedItem, quantity: quantity || 1 };
          })
          .filter(item => item.item && isValidItemName(item.item));
        
        ingredients.push(...items);
      }
    }

    if (ingredients.length === 0) return null;

    // Determine if it's shapeless based on content
    const isShapeless = /shapeless/i.test(content);

    return {
      ingredients,
      recipe_type: isShapeless ? 'shapeless' : 'shaped',
      pattern: isShapeless ? 'Any arrangement' : 'Specific pattern required'
    };
    
  } catch (error) {
    return null;
  }
}

/**
 * Clean and normalize item names with comprehensive validation
 */
function cleanItemName(name: string): string {
  if (!name) return '';
  
  return name
    .replace(/<[^>]*>/g, '') // Remove HTML tags
    .replace(/\[\[([^|\]]+)(?:\|[^\]]+)?\]\]/g, '$1') // MediaWiki links [[item|display]] -> item
    .replace(/{{[^}]*}}/g, '') // Remove templates
    .replace(/[{}[\]]/g, '') // Remove remaining brackets
    .replace(/&[a-zA-Z0-9#]+;/g, ' ') // Remove HTML entities (decoded separately)
    .replace(/\d+\s*[×x]\s*/gi, '') // Remove quantity prefixes like "8×" or "3x"
    .replace(/^\s*\d+\s*/, '') // Remove leading numbers
    .replace(/\(\d+\)/g, '') // Remove quantity in parentheses like (3)
    .replace(/\s+/g, ' ') // Normalize spaces
    .trim();
}

/**
 * Enhanced quantity extraction supporting multiple formats
 */
function extractQuantityFromText(text: string): number | null {
  if (!text) return null;
  
  // Pattern for various quantity formats: ×3, 3×, (3), 3 items, etc.
  const patterns = [
    /(\d+)\s*[×x]/i,      // 3× or 3x
    /[×x]\s*(\d+)/i,      // ×3 or x3
    /\((\d+)\)/,          // (3)
    /(\d+)\s*items?/i,    // 3 items
    /(\d+)\s*pieces?/i,   // 3 pieces
    /^(\d+)\s*$/,         // Just a number
    /^(\d+)\s+/,          // Number at start
  ];
  
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) {
      const quantity = parseInt(match[1]);
      return quantity > 0 ? quantity : null;
    }
  }
  
  return null;
}

/**
 * Validate that extracted text is a valid item name, not HTML fragments
 */
function isValidItemName(name: string): boolean {
  if (!name || name.length < 2) return false;
  
  // Check for HTML fragments that shouldn't be item names
  const invalidPatterns = [
    /^[<>&"']+$/,        // Only HTML characters
    /^\s*[{}[\]]+\s*$/,  // Only brackets
    /^[\d\s×x()]+$/,     // Only numbers and quantity indicators
    /^s[">]/,            // Common corruption like 's">'
    /<[^>]*>/,           // Contains HTML tags
    /^[^a-zA-Z]*$/,      // Contains no letters at all
    /[">]{2,}/,          // Multiple HTML quote/angle characters
    /^[">]/,             // Starts with HTML quote/angle
    /["><&;]{3,}/,       // Multiple HTML entities/characters
  ];
  
  return !invalidPatterns.some(pattern => pattern.test(name));
}

/**
 * Enhanced content sanitization that preserves recipe information
 */
export function sanitizeWikiContentWithRecipes(text: string): string {
  // Preserve some structure that's useful for recipe parsing before general sanitization
  let processed = text
    // Preserve template structure temporarily
    .replace(/{{([^}]+)}}/g, '{{$1}}')
    // Preserve table structure temporarily
    .replace(/<table[^>]*>/gi, '<TABLE>')
    .replace(/<\/table>/gi, '</TABLE>')
    .replace(/<tr[^>]*>/gi, '<TR>')
    .replace(/<\/tr>/gi, '</TR>')
    .replace(/<t[hd][^>]*>/gi, '<TD>')
    .replace(/<\/t[hd]>/gi, '</TD>');

  // Then apply standard sanitization but preserve our markers
  processed = processed
    .replace(/<[^>]*>/g, ' ') // Remove other HTML tags
    .replace(/\s+/g, ' ') // Normalize spaces
    .trim();

  return processed;
}