/**
 * Pure TypeScript replacement for the former qp.xslt / XSLTProcessor based rendering.
 *
 * This module is a faithful port of the XSLT stylesheet: it produces the same DOM
 * structure (.qp-root > .qp-statement-header / .qp-tr trees with .qp-node and .qp-tt
 * tooltips) so that lines.ts, tooltip.ts, node.ts and qp.css keep working unchanged.
 *
 * Where the stylesheet relied on XSLT 1.0 semantics, those are reproduced here:
 * - template conflict resolution ("last matching template wins" for equal priority)
 * - number() / sum() semantics (empty node-set sums to 0, missing attribute is NaN)
 * - format-number(x, '0.#######') and format-number(x, '0%') formatting
 */

const QP_TR_NAMES = ["RelOp", "StmtSimple", "StmtUseDb", "StmtCond", "StmtCursor", "Operation"];

/**
 * Renders the given showplan XML document, returning the .qp-root element.
 */
function renderPlan(xmlDoc: Document): HTMLElement {
    let root = element("div", "qp-root");
    let showPlanXml = xmlDoc.documentElement;
    if (showPlanXml == null || showPlanXml.localName != "ShowPlanXML") {
        return root;
    }
    let statements = selectPath(showPlanXml, ["BatchSequence", "Batch", "Statements"]);
    for (let i = 0; i < statements.length; i++) {
        let children = childElements(statements[i]);
        for (let j = 0; j < children.length; j++) {
            renderStatement(root, children[j]);
        }
    }
    return root;
}

function renderStatement(root: HTMLElement, statement: Element) {
    let header = element("div", "qp-statement-header");
    let headerRow = element("div", "qp-statement-header-row");
    let text = element("div");
    text.appendChild(document.createTextNode(getAttr(statement, "StatementText") || ""));
    headerRow.appendChild(text);
    header.appendChild(headerRow);

    let missingIndexGroups = selectPath(statement, ["QueryPlan", "MissingIndexes", "MissingIndexGroup"]);
    for (let i = 0; i < missingIndexGroups.length; i++) {
        header.appendChild(renderMissingIndex(missingIndexGroups[i]));
    }
    root.appendChild(header);

    // <xsl:apply-templates select="." mode="QpTr" /> - including the XSLT built-in
    // rule that recurses into children of elements with no matching template.
    let matched: Element[] = [];
    collectQpTrNodes(statement, matched);
    for (let i = 0; i < matched.length; i++) {
        root.appendChild(renderQpTr(matched[i]));
    }
}

function renderMissingIndex(group: Element): HTMLElement {
    let row = element("div", "qp-statement-header-row missing-index");
    let div = element("div");
    let textContent = "Missing Index (Impact " + (getAttr(group, "Impact") || "") + "): ";
    let missingIndexes = childElements(group, "MissingIndex");
    for (let i = 0; i < missingIndexes.length; i++) {
        textContent += createIndexText(missingIndexes[i]);
    }
    div.appendChild(document.createTextNode(textContent));
    row.appendChild(div);
    return row;
}

/** Produces the "CREATE INDEX ..." text for a MissingIndex element. */
function createIndexText(missingIndex: Element): string {
    let text = "CREATE NONCLUSTERED INDEX [<Name of Missing Index, sysname,>] ON "
        + (getAttr(missingIndex, "Schema") || "") + "." + (getAttr(missingIndex, "Table") || "") + " (";
    let keyColumns: string[] = [];
    let includeColumns: string[] = [];
    let columnGroups = childElements(missingIndex, "ColumnGroup");
    for (let i = 0; i < columnGroups.length; i++) {
        let usage = getAttr(columnGroups[i], "Usage");
        let columns = childElements(columnGroups[i], "Column");
        for (let j = 0; j < columns.length; j++) {
            let name = getAttr(columns[j], "Name") || "";
            (usage == "INCLUDE" ? includeColumns : keyColumns).push(name);
        }
    }
    text += keyColumns.join(",") + ")";
    if (includeColumns.length > 0) {
        text += " INCLUDE (" + includeColumns.join(",") + ")";
    }
    return text;
}

/**
 * Collects the elements a QpTr-mode apply-templates would render: elements matching
 * the QpTr template list directly, otherwise recursing into children (built-in rule).
 */
function collectQpTrNodes(node: Element, out: Element[]) {
    if (QP_TR_NAMES.indexOf(node.localName) >= 0) {
        out.push(node);
        return;
    }
    let children = childElements(node);
    for (let i = 0; i < children.length; i++) {
        collectQpTrNodes(children[i], out);
    }
}

/** Renders one node of the plan tree (a .qp-tr element with the node and its children). */
function renderQpTr(node: Element): HTMLElement {
    let tr = element("div", "qp-tr");
    let statementId = getAttr(node, "StatementId");
    if (statementId != null) {
        tr.setAttribute("data-statement-id", statementId);
    }

    let nodeWrapper = element("div");
    let nodeOuter = element("div", "qp-node-outer");
    let qpNode = element("div", "qp-node");
    let nodeId = getAttr(node, "NodeId");
    if (nodeId != null) {
        qpNode.setAttribute("data-node-id", nodeId);
    }

    qpNode.appendChild(renderNodeIcon(node));

    let label = element("div");
    label.appendChild(document.createTextNode(getNodeLabel(node)));
    qpNode.appendChild(label);

    let label2 = getNodeLabel2(node);
    if (label2 != null) {
        let label2Div = element("div");
        label2Div.appendChild(document.createTextNode(label2));
        qpNode.appendChild(label2Div);
    }

    let costLabel = getNodeCostLabel(node);
    if (costLabel != null) {
        let costDiv = element("div");
        costDiv.appendChild(document.createTextNode(costLabel));
        qpNode.appendChild(costDiv);
    }

    qpNode.appendChild(renderToolTip(node));

    nodeOuter.appendChild(qpNode);
    nodeWrapper.appendChild(nodeOuter);
    tr.appendChild(nodeWrapper);

    // <xsl:apply-templates select="*/*" mode="QpTr" />
    let childContainer = element("div");
    let matched: Element[] = [];
    let children = childElements(node);
    for (let i = 0; i < children.length; i++) {
        let grandChildren = childElements(children[i]);
        for (let j = 0; j < grandChildren.length; j++) {
            collectQpTrNodes(grandChildren[j], matched);
        }
    }
    for (let i = 0; i < matched.length; i++) {
        childContainer.appendChild(renderQpTr(matched[i]));
    }
    tr.appendChild(childContainer);

    return tr;
}

/** Renders the node icon (template name="NodeIcon"). */
function renderNodeIcon(node: Element): HTMLElement {
    let physicalOp = getAttr(node, "PhysicalOp");
    let cursorType = getPath(node, ["CursorPlan"], "CursorActualType");
    let operationType = getAttr(node, "OperationType");
    let iconName: string;
    if (physicalOp == "Parallelism") {
        iconName = removeSpaces(getAttr(node, "LogicalOp") || "");
    } else if (cursorType != null) {
        iconName = cursorType;
    } else if (operationType != null) {
        iconName = operationType;
    } else if (getPath(node, ["IndexScan"], "Lookup") != null) {
        iconName = "KeyLookup";
    } else if (getPath(node, ["IndexScan"], "Storage") == "ColumnStore") {
        iconName = "ColumnStoreIndexScan";
    } else if (getPath(node, ["ScalarInsert", "Object"], "Storage") == "ColumnStore") {
        iconName = "ColumnStoreIndexInsert";
    } else if (getPath(node, ["Update", "Object"], "Storage") == "ColumnStore") {
        iconName = "ColumnStoreIndex" + (getAttr(node, "LogicalOp") || "");
    } else if (childElements(node, "TableValuedFunction").length > 0) {
        iconName = "TableValuedFunction";
    } else if (physicalOp != null) {
        iconName = removeSpaces(physicalOp);
    } else if (node.localName == "StmtSimple") {
        iconName = "Statement";
    } else if (node.localName == "StmtCursor") {
        iconName = "StmtCursor";
    } else if (node.localName == "StmtCond") {
        iconName = "StmtCond";
    } else {
        iconName = "Catchall";
    }

    let icon = element("div", "qp-icon-" + iconName);
    if (childElements(node, "Warnings").length > 0 || selectPath(node, ["QueryPlan", "Warnings"]).length > 0) {
        icon.appendChild(element("div", "qp-iconwarn"));
    }
    let parallel = getAttr(node, "Parallel");
    if (parallel == "1" || parallel == "true") {
        icon.appendChild(element("div", "qp-iconpar"));
    }
    let executionMode = getPath(node, ["RunTimeInformation", "RunTimeCountersPerThread"], "ActualExecutionMode")
        || getAttr(node, "EstimatedExecutionMode");
    if (executionMode == "Batch") {
        icon.appendChild(element("div", "qp-iconbatch"));
    }
    return icon;
}

/**
 * Main node label (mode="NodeLabel"). Templates are checked in reverse stylesheet
 * order to mirror the XSLT "last matching template wins" conflict resolution.
 */
function getNodeLabel(node: Element): string {
    let operationType = getAttr(node, "OperationType");
    if (operationType == "RefreshQuery") return "Refresh Query";
    if (operationType == "PopulateQuery") return "Population Query";
    if (operationType == "FetchQuery") return "Fetch Query";

    let cursorType = getPath(node, ["CursorPlan"], "CursorActualType");
    if (cursorType == "SnapShot") return "Snapshot";
    if (cursorType == "Keyset") return "Keyset";
    if (cursorType == "FastForward") return "Fast Forward";
    if (cursorType == "Dynamic") return "Dynamic";

    if (childElements(node, "StoredProc").length > 0) return "Stored Procedure";

    let statementType = getAttr(node, "StatementType");
    if (statementType != null) return statementType;

    if (node.localName == "RelOp") {
        let indexScans = childElements(node, "IndexScan");
        if (indexScans.length > 0) {
            let indexScan = indexScans[0];
            let label: string;
            if (getAttr(indexScan, "Storage") == "ColumnStore") {
                label = "Columnstore Index Scan";
            } else if (getAttr(indexScan, "Lookup") != null && getPath(indexScan, ["Object"], "IndexKind") == "Clustered") {
                label = "Key Lookup";
            } else if (getAttr(indexScan, "Lookup") != null) {
                label = "RID Lookup";
            } else {
                label = getAttr(node, "PhysicalOp") || "";
            }
            // <xsl:if test="s:IndexScan/s:Object/@IndexKind"> - first Object of any IndexScan child
            let indexKind = getPathFrom(node, ["IndexScan", "Object"], "IndexKind");
            if (indexKind != null) {
                label += " (" + indexKind + ")";
            }
            return label;
        }
        if (getPath(node, ["Update", "Object"], "Storage") == "ColumnStore") {
            return "Columnstore Index " + (getAttr(node, "LogicalOp") || "");
        }
        if (getPath(node, ["ScalarInsert", "Object"], "Storage") == "ColumnStore") {
            return "Columnstore Index Insert";
        }
        return getAttr(node, "PhysicalOp") || "";
    }
    return "";
}

/**
 * Second node label (mode="NodeLabel2"), or null if the node has none. The
 * "(LogicalOp)" template is later in the stylesheet, so it wins over the object name.
 */
function getNodeLabel2(node: Element): string {
    if (node.localName == "RelOp") {
        let logicalOp = getAttr(node, "LogicalOp");
        let physicalOp = getAttr(node, "PhysicalOp");
        if (logicalOp != null && physicalOp != null && logicalOp != physicalOp) {
            return "(" + logicalOp + ")";
        }
    }
    let objects = grandChildObjects(node);
    if (objects.length > 0) {
        let name = "";
        for (let i = 0; i < objects.length; i++) {
            name += objectName(objects[i], ["Table", "Index", "Column", "Alias"]);
        }
        // substring($ObjectName, 0, 36) + "…" when 36 chars or longer
        if (name.length >= 36) {
            return name.substring(0, 35) + "…";
        }
        return name;
    }
    return null;
}

/** Cost label (mode="NodeCostLabel"), or null for plain statements. */
function getNodeCostLabel(node: Element): string {
    if (node.localName == "RelOp") {
        let estimatedOperatorCost = getEstimatedOperatorCost(node);
        let totalCost = getStatementTotalCost(node);
        return "Cost: " + formatPercent(divide(estimatedOperatorCost, totalCost));
    }
    if (node.localName == "StmtCursor" || node.localName == "Operation" || node.localName == "StmtCond") {
        return "Cost: 0%";
    }
    return null;
}

/** EstimatedOperatorCost template: own subtree cost minus the child operators' costs. */
function getEstimatedOperatorCost(node: Element): number {
    let own = getAttr(node, "EstimatedTotalSubtreeCost");
    let ownCost = own != null ? toNumber(own) : 0;
    let childCost = 0;
    let children = childElements(node);
    for (let i = 0; i < children.length; i++) {
        let childRelOps = childElements(children[i], "RelOp");
        for (let j = 0; j < childRelOps.length; j++) {
            childCost += toNumber(getAttr(childRelOps[j], "EstimatedTotalSubtreeCost"));
        }
    }
    let result = ownCost - childCost;
    return result < 0 ? 0 : result;
}

/** ancestor::s:QueryPlan/s:RelOp/@EstimatedTotalSubtreeCost - the statement total cost. */
function getStatementTotalCost(node: Element): number {
    let ancestor = node.parentNode;
    while (ancestor != null && ancestor.nodeType == 1) {
        if ((<Element>ancestor).localName == "QueryPlan") {
            let relOps = childElements(<Element>ancestor, "RelOp");
            if (relOps.length > 0) {
                return toNumber(getAttr(relOps[0], "EstimatedTotalSubtreeCost"));
            }
            return NaN;
        }
        ancestor = ancestor.parentNode;
    }
    return NaN;
}

/** Renders the .qp-tt tooltip for a node. */
function renderToolTip(node: Element): HTMLElement {
    let tt = element("div", "qp-tt");

    let header = element("div", "qp-tt-header");
    header.appendChild(document.createTextNode(getNodeLabel(node)));
    tt.appendChild(header);

    let description = element("div");
    description.appendChild(document.createTextNode(getToolTipDescription(node)));
    tt.appendChild(description);

    tt.appendChild(renderToolTipGrid(node));
    renderToolTipDetails(tt, node);

    // Warnings section, evaluated against the statement's QueryPlan when present.
    let queryPlans = childElements(node, "QueryPlan");
    renderWarningsSection(tt, queryPlans.length > 0 ? queryPlans[0] : node);

    return tt;
}

/**
 * Tooltip description (mode="ToolTipDescription"), checked in reverse stylesheet
 * order ("last matching template wins").
 */
function getToolTipDescription(node: Element): string {
    let cursorType = getPath(node, ["CursorPlan"], "CursorActualType");
    if (cursorType == "SnapShot") return "A cursor that does not see changes made by others.";
    if (cursorType == "Keyset") return "Cursor that can see updates made by others, but not inserts.";
    if (cursorType == "Dynamic") return "Cursor that can see all changes made by others.";
    if (cursorType == "FastForward") return "Fast Forward.";

    let operationType = getAttr(node, "OperationType");
    if (operationType == "PopulateQuery") return "The query used to populate a cursor's work table when the cursor is opened.";
    if (operationType == "FetchQuery") return "The query used to retrieve rows when a fetch is issued against a cursor.";

    if (childElements(node, "Top").length > 0) return "Select the first few rows based on a sort order.";
    if (childElements(node, "NestedLoops").length > 0) return "For each row in the top (outer) input, scan the bottom (inner) input, and output matching rows.";
    if (childElements(node, "TableScan").length > 0) return "Scan rows from a table.";

    let physicalOp = getAttr(node, "PhysicalOp");
    if (physicalOp == "Parallelism") return "An operation involving parallelism.";
    if (getPath(node, ["IndexScan"], "Lookup") != null) return "Uses a supplied clustering key to lookup on a table that has a clustered index.";
    if (physicalOp == "Index Spool") return "Reformats the data from the input into a temporary index, which is then used for seeking with the supplied seek predicate.";
    if (physicalOp == "Adaptive Join") return "Chooses dynamically between hash join and nested loops.";
    if (physicalOp == "Index Seek") return "Scan a particular range of rows from a nonclustered index.";
    if (physicalOp == "Clustered Index Seek") return "Scanning a particular range of rows from a clustered index.";
    if (physicalOp == "Bitmap") return "Bitmap.";
    if (physicalOp == "Hash Match") return "Use each row from the top input to build a hash table, and each row from the bottom input to probe into the hash table, outputting all matching rows.";
    if (physicalOp == "Stream Aggregate") return "Compute summary values for groups of rows in a suitably sorted stream.";
    if (physicalOp == "Clustered Index Scan") return "Scanning a clustered index, entirely or only a range.";
    if (physicalOp == "Sort") return "Sort the input.";
    if (physicalOp == "Compute Scalar") return "Compute new values from existing values in a row.";
    if (physicalOp == "Table Insert") return "Insert input rows into the table specified in Argument field.";
    return "";
}

/** Renders the tooltip property grid (template name="ToolTipGrid"). */
function renderToolTipGrid(node: Element): HTMLElement {
    let tableElement = element("table");
    // the XSLT html output method wrapped rows in an implicit tbody
    let table = element("tbody");
    tableElement.appendChild(table);

    let cachedPlanSize = getPath(node, ["QueryPlan"], "CachedPlanSize");
    addRow(table, "Cached plan size", cachedPlanSize + " KB", cachedPlanSize != null);

    let physicalOp = getAttr(node, "PhysicalOp");
    let isLookup = getPath(node, ["IndexScan"], "Lookup") != null;
    addRow(table, "Physical Operation", isLookup ? "Key Lookup" : physicalOp, physicalOp != null);

    let logicalOp = getAttr(node, "LogicalOp");
    addRow(table, "Logical Operation", isLookup ? "Key Lookup" : logicalOp, logicalOp != null);

    let actualJoinType = getPath(node, ["RunTimeInformation", "RunTimeCountersPerThread"], "ActualJoinType");
    addRow(table, "Actual Join Type", actualJoinType, actualJoinType != null);

    let hasRunTimeInformation = childElements(node, "RunTimeInformation").length > 0;
    let actualExecutionMode = getPath(node, ["RunTimeInformation", "RunTimeCountersPerThread"], "ActualExecutionMode");
    addRow(table, "Actual Execution Mode", actualExecutionMode != null ? actualExecutionMode : "Row", hasRunTimeInformation);

    let estimatedJoinType = getAttr(node, "EstimatedJoinType");
    addRow(table, "Estimated Join Type", estimatedJoinType, estimatedJoinType != null);

    let isAdaptive = getAttr(node, "IsAdaptive");
    addRow(table, "Is Adaptive", isAdaptive == "true" ? "True" : "False", isAdaptive != null);

    let estimatedExecutionMode = getAttr(node, "EstimatedExecutionMode");
    addRow(table, "Estimated Execution Mode", estimatedExecutionMode, estimatedExecutionMode != null);

    let storage = getPath(node, ["IndexScan"], "Storage");
    if (storage == null) storage = getPath(node, ["TableScan"], "Storage");
    addRow(table, "Storage", storage, storage != null);

    let actualRowsRead = sumCounter(node, "ActualRowsRead");
    addRow(table, "Number of Rows Read", numberToString(actualRowsRead), isTruthyNumber(actualRowsRead));

    let adaptiveThresholdRows = getAttr(node, "AdaptiveThresholdRows");
    addRow(table, "Adaptive Threshold Rows", adaptiveThresholdRows, adaptiveThresholdRows != null);

    addRow(table, "Actual Number of Rows", numberToString(sumCounter(node, "ActualRows")), hasRunTimeInformation);
    addRow(table, "Actual Number of Batches", numberToString(sumCounter(node, "Batches")), hasRunTimeInformation);

    let estimatedOperatorCost = getEstimatedOperatorCost(node);
    let totalCost = getStatementTotalCost(node);
    let percentage = totalCost > 0 ? estimatedOperatorCost / totalCost : 0;
    addRow(table, "Estimated Operator Cost", formatRounded(estimatedOperatorCost) + " (" + formatPercent(percentage) + ")", true);

    let estimateIO = getAttr(node, "EstimateIO");
    addRow(table, "Estimated I/O Cost", formatRounded(toNumber(estimateIO)), estimateIO != null);

    let estimateCPU = getAttr(node, "EstimateCPU");
    addRow(table, "Estimated CPU Cost", formatRounded(toNumber(estimateCPU)), estimateCPU != null);

    let subtreeCost = getAttr(node, "StatementSubTreeCost");
    if (subtreeCost == null) subtreeCost = getAttr(node, "EstimatedTotalSubtreeCost");
    addRow(table, "Estimated Subtree Cost", formatRounded(toNumber(subtreeCost)), subtreeCost != null);

    let estimateRebinds = getAttr(node, "EstimateRebinds");
    let estimatedExecutions = toNumber(estimateRebinds) + 1;
    addRow(table, "Estimated Number of Executions", numberToString(estimatedExecutions), isTruthyNumber(estimatedExecutions));

    let actualExecutions = sumCounter(node, "ActualExecutions");
    addRow(table, "Number of Executions", numberToString(actualExecutions), isTruthyNumber(actualExecutions));

    let degreeOfParallelism = getPath(node, ["QueryPlan"], "DegreeOfParallelism");
    addRow(table, "Degree of Parallelism", degreeOfParallelism, degreeOfParallelism != null);

    let memoryGrant = getPath(node, ["QueryPlan"], "MemoryGrant");
    addRow(table, "Memory Grant", memoryGrant, memoryGrant != null);

    let estimatedRowsRead = getAttr(node, "EstimatedRowsRead");
    addRow(table, "Estimated Number of Rows to be Read", estimatedRowsRead, estimatedRowsRead != null);

    let estimateRows = getAttr(node, "StatementEstRows");
    if (estimateRows == null) estimateRows = getAttr(node, "EstimateRows");
    addRow(table, "Estimated Number of Rows", estimateRows, estimateRows != null);

    let avgRowSize = getAttr(node, "AvgRowSize");
    addRow(table, "Estimated Row Size", avgRowSize + " B", avgRowSize != null);

    addRow(table, "Actual Rebinds", numberToString(sumCounter(node, "ActualRebinds")), hasRunTimeInformation);
    addRow(table, "Actual Rewinds", numberToString(sumCounter(node, "ActualRewinds")), hasRunTimeInformation);

    let ordered = getPath(node, ["IndexScan"], "Ordered");
    addRow(table, "Ordered", ordered == "true" || toNumber(ordered) == 1 ? "True" : "False", ordered != null);

    let partitioningType = getPath(node, ["Parallelism"], "PartitioningType");
    addRow(table, "Partitioning Type", partitioningType, partitioningType != null);

    let nodeId = getAttr(node, "NodeId");
    addRow(table, "Node ID", nodeId, nodeId != null);

    return tableElement;
}

function addRow(table: HTMLElement, label: string, value: string, condition: boolean) {
    if (!condition) return;
    let tr = element("tr");
    let th = element("th");
    th.appendChild(document.createTextNode(label));
    let td = element("td");
    td.appendChild(document.createTextNode(value == null ? "" : value));
    tr.appendChild(th);
    tr.appendChild(td);
    table.appendChild(tr);
}

/**
 * Tooltip detail sections (mode="ToolTipDetails"), applied to the node's attributes,
 * children, children's attributes and grandchildren in document order.
 */
function renderToolTipDetails(tt: HTMLElement, node: Element) {
    applyDetailAttributes(tt, node);
    let children = childElements(node);
    for (let i = 0; i < children.length; i++) {
        applyDetailTemplate(tt, children[i], node);
        applyDetailAttributes(tt, children[i]);
        let grandChildren = childElements(children[i]);
        for (let j = 0; j < grandChildren.length; j++) {
            applyDetailTemplate(tt, grandChildren[j], children[i]);
        }
    }
}

function applyDetailAttributes(tt: HTMLElement, node: Element) {
    if (getAttr(node, "StatementText") != null) {
        addSection(tt, "Statement", [getAttr(node, "StatementText")]);
    }
}

function applyDetailTemplate(tt: HTMLElement, node: Element, parent: Element) {
    let name = node.localName;

    if (name == "Object") {
        addSection(tt, "Object", [objectName(node, FULL_NAME_ATTRS)]);
        return;
    }

    if ((name == "SetPredicate" || name == "Predicate") && getPathFrom(node, ["ScalarOperator"], "ScalarString") != null) {
        addSection(tt, "Predicate", [getPathFrom(node, ["ScalarOperator"], "ScalarString")]);
        return;
    }

    if (name == "TopExpression" && getPathFrom(node, ["ScalarOperator"], "ScalarString") != null) {
        addSection(tt, "Top Expression", [getPathFrom(node, ["ScalarOperator"], "ScalarString")]);
        return;
    }

    if (name == "OutputList") {
        let columns = childElements(node, "ColumnReference");
        if (columns.length > 0) {
            addSection(tt, "Output List", mapObjectNames(columns, FULL_NAME_ATTRS));
        }
        return;
    }

    if (name == "HashKeysProbe" && parent.localName == "AdaptiveJoin") {
        addSection(tt, "Hash Keys Probe", mapObjectNames(childElements(node, "ColumnReference"), NO_ALIAS_ATTRS));
        return;
    }

    if (name == "OuterReferences" && parent.localName == "AdaptiveJoin") {
        addSection(tt, "Outer References", mapObjectNames(childElements(node, "ColumnReference"), NO_ALIAS_ATTRS));
        return;
    }

    if (name == "OuterReferences" && parent.localName == "NestedLoops") {
        let columns = childElements(node, "ColumnReference");
        if (columns.length > 0) {
            addSection(tt, "Outer References", mapObjectNames(columns, FULL_NAME_ATTRS));
        }
        return;
    }

    if (name == "StoredProc" && parent.localName == "StmtSimple") {
        addSection(tt, "Procedure Name", [getAttr(node, "ProcName")]);
        return;
    }

    if (name == "OrderBy" && parent.localName == "Sort") {
        let orderByColumns = childElements(node, "OrderByColumn");
        let lines: string[] = [];
        for (let i = 0; i < orderByColumns.length; i++) {
            let columns = childElements(orderByColumns[i], "ColumnReference");
            if (columns.length == 0) continue;
            let ascending = getAttr(orderByColumns[i], "Ascending");
            let direction = (ascending == "true" || toNumber(ascending) == 1) ? " Ascending" : " Descending";
            lines.push(mapObjectNames(columns, FULL_NAME_ATTRS).join("") + direction);
        }
        if (lines.length > 0) {
            addSection(tt, "Order By", lines);
        }
        return;
    }

    if (name == "SeekPredicates") {
        let details: string[] = [];
        let seekPredicates = childElements(node, "SeekPredicateNew");
        for (let i = 0; i < seekPredicates.length; i++) {
            let seekKeys = childElements(seekPredicates[i], "SeekKeys");
            for (let j = 0; j < seekKeys.length; j++) {
                details.push(seekKeyDetail(seekKeys[j], details.length + 1));
            }
        }
        addSection(tt, "Seek Predicates", [details.join(", ")]);
        return;
    }
}

/** template name="SeekKeyDetail" */
function seekKeyDetail(seekKeys: Element, position: number): string {
    let text = "Seek Keys[" + position + "]: ";
    let parts: string[] = [];
    let children = childElements(seekKeys);
    for (let i = 0; i < children.length; i++) {
        let child = children[i];
        let name = child.localName;
        if (name != "Prefix" && name != "StartRange" && name != "EndRange") continue;
        let part = name == "Prefix" ? "Prefix: " : name == "StartRange" ? "Start: " : "End: ";
        let rangeColumns = selectPath(child, ["RangeColumns", "ColumnReference"]);
        part += mapObjectNames(rangeColumns, NO_ALIAS_ATTRS).join(", ");
        let scanType = getAttr(child, "ScanType");
        if (scanType == "EQ") part += " = ";
        else if (scanType == "LT") part += " < ";
        else if (scanType == "GT") part += " > ";
        else if (scanType == "LE") part += " <= ";
        else if (scanType == "GE") part += " >= ";
        let expressions = selectPath(child, ["RangeExpressions", "ScalarOperator"]);
        let expressionParts: string[] = [];
        for (let j = 0; j < expressions.length; j++) {
            expressionParts.push("Scalar Operator(" + (getAttr(expressions[j], "ScalarString") || "") + ")");
        }
        part += expressionParts.join(", ");
        parts.push(part);
    }
    return text + parts.join(", ");
}

/** The Warnings tooltip section (template name="ToolTipDetails"). */
function renderWarningsSection(tt: HTMLElement, context: Element) {
    let warnings = childElements(context, "Warnings");
    if (warnings.length == 0) return;

    let title = element("div", "qp-bold");
    title.appendChild(document.createTextNode("Warnings"));
    tt.appendChild(title);

    let body = element("div");
    let addLine = function (text: string) {
        let div = element("div");
        div.appendChild(document.createTextNode(text));
        body.appendChild(div);
    };

    // s:Warnings/@NoJoinPredicate=1 (the "=true" branch in the stylesheet compared
    // against a child element named "true" and could never match)
    for (let i = 0; i < warnings.length; i++) {
        if (toNumber(getAttr(warnings[i], "NoJoinPredicate")) == 1) {
            addLine("No Join Predicate");
            break;
        }
    }

    let unmatched = selectPath(context, ["UnmatchedIndexes", "Parameterization", "Object"]);
    for (let i = 0; i < unmatched.length; i++) {
        addLine("Unmatched index: " + objectName(unmatched[i], NO_ALIAS_ATTRS));
    }

    let warningsElement = warnings[0];
    let all = childElements(warningsElement);
    let spills = filterByName(all, "SpillToTempDb");
    for (let i = 0; i < spills.length; i++) {
        addLine("Operator used tempdb to spill data during execution with spill level "
            + (getAttr(spills[i], "SpillLevel") || "") + " and "
            + (getAttr(spills[i], "SpilledThreadCount") || "") + " spilled thread(s)");
    }
    let noStatistics = selectPath(warningsElement, ["ColumnsWithNoStatistics", "ColumnReference"]);
    for (let i = 0; i < noStatistics.length; i++) {
        addLine("Columns With No Statistics: " + objectName(noStatistics[i], NO_ALIAS_ATTRS));
    }
    let waits = filterByName(all, "Wait");
    for (let i = 0; i < waits.length; i++) {
        addLine("The query had to wait " + (getAttr(waits[i], "WaitTime") || "") + " seconds for "
            + (getAttr(waits[i], "WaitType") || "") + " during execution.");
    }
    let converts = filterByName(all, "PlanAffectingConvert");
    for (let i = 0; i < converts.length; i++) {
        addLine("Type conversion in expression (" + (getAttr(converts[i], "Expression") || "")
            + ") may affect \"" + (getAttr(converts[i], "ConvertIssue") || "") + "\" in query plan choice.");
    }
    let sortSpills = filterByName(all, "SortSpillDetails");
    for (let i = 0; i < sortSpills.length; i++) {
        addLine((getAttr(context, "LogicalOp") || "") + " wrote " + (getAttr(sortSpills[i], "WritesToTempDb") || "")
            + " pages to and read " + (getAttr(sortSpills[i], "ReadsFromTempDb") || "")
            + " pages from tempdb with granted memory " + (getAttr(sortSpills[i], "GrantedMemoryKb") || "")
            + "KB and used memory " + (getAttr(sortSpills[i], "UsedMemoryKb") || "") + "KB.");
    }
    let memoryGrants = filterByName(all, "MemoryGrantWarning");
    for (let i = 0; i < memoryGrants.length; i++) {
        addLine("The query memory grant detected \"" + (getAttr(memoryGrants[i], "GrantWarningKind") || "")
            + "\", which may impact the reliability. Grant size: Initial " + (getAttr(memoryGrants[i], "RequestedMemory") || "")
            + " KB, Final " + (getAttr(memoryGrants[i], "GrantedMemory") || "")
            + " KB, Used " + (getAttr(memoryGrants[i], "MaxUsedMemory") || "") + " KB.");
    }
    let hashSpills = filterByName(all, "HashSpillDetails");
    for (let i = 0; i < hashSpills.length; i++) {
        addLine("Hash wrote " + (getAttr(hashSpills[i], "WritesToTempDb") || "")
            + " pages to and read " + (getAttr(hashSpills[i], "ReadsFromTempDb") || "")
            + " pages from tempdb with granted memory " + (getAttr(hashSpills[i], "GrantedMemoryKb") || "")
            + "KB and used memory " + (getAttr(hashSpills[i], "UsedMemoryKb") || "") + "KB.");
    }

    tt.appendChild(body);
}

function addSection(tt: HTMLElement, title: string, lines: string[]) {
    let titleDiv = element("div", "qp-bold");
    titleDiv.appendChild(document.createTextNode(title));
    tt.appendChild(titleDiv);
    for (let i = 0; i < lines.length; i++) {
        let div = element("div");
        div.appendChild(document.createTextNode(lines[i] == null ? "" : lines[i]));
        tt.appendChild(div);
    }
}

/*
 * ================================
 * Object name helpers
 * ================================
 */

const FULL_NAME_ATTRS = ["Database", "Schema", "Table", "Index", "Column", "Alias"];
const NO_ALIAS_ATTRS = ["Database", "Schema", "Table", "Index", "Column"];

/**
 * Joins the given attributes with "." in document order (mode="ObjectName" /
 * "ObjectNameNoAlias" / the ExcludeDatabaseName variant).
 */
function objectName(node: Element, attrNames: string[]): string {
    let parts: string[] = [];
    for (let i = 0; i < node.attributes.length; i++) {
        let attribute = node.attributes[i];
        if (attrNames.indexOf(attribute.name) >= 0) {
            parts.push(attribute.value);
        }
    }
    return parts.join(".");
}

function mapObjectNames(nodes: Element[], attrNames: string[]): string[] {
    let result: string[] = [];
    for (let i = 0; i < nodes.length; i++) {
        result.push(objectName(nodes[i], attrNames));
    }
    return result;
}

// All s:Object elements at grandchild level (helper for the "star-slash-Object" match).
function grandChildObjects(node: Element): Element[] {
    let result: Element[] = [];
    let children = childElements(node);
    for (let i = 0; i < children.length; i++) {
        let objects = childElements(children[i], "Object");
        for (let j = 0; j < objects.length; j++) {
            result.push(objects[j]);
        }
    }
    return result;
}

/*
 * ================================
 * XML helpers
 * ================================
 */

function element(name: string, className?: string): HTMLElement {
    let result = document.createElement(name);
    if (className != null) {
        result.className = className;
    }
    return result;
}

/** Element children, optionally filtered by local name. */
function childElements(node: Element, name?: string): Element[] {
    let result: Element[] = [];
    let childNodes = node.childNodes;
    for (let i = 0; i < childNodes.length; i++) {
        let child = childNodes[i];
        if (child.nodeType == 1 && (name == null || (<Element>child).localName == name)) {
            result.push(<Element>child);
        }
    }
    return result;
}

function filterByName(nodes: Element[], name: string): Element[] {
    let result: Element[] = [];
    for (let i = 0; i < nodes.length; i++) {
        if (nodes[i].localName == name) {
            result.push(nodes[i]);
        }
    }
    return result;
}

/** All elements matching the given child path (like an XPath location path). */
function selectPath(node: Element, path: string[]): Element[] {
    let current = [node];
    for (let i = 0; i < path.length; i++) {
        let next: Element[] = [];
        for (let j = 0; j < current.length; j++) {
            let matches = childElements(current[j], path[i]);
            for (let k = 0; k < matches.length; k++) {
                next.push(matches[k]);
            }
        }
        current = next;
    }
    return current;
}

function getAttr(node: Element, name: string): string {
    return node.hasAttribute(name) ? node.getAttribute(name) : null;
}

/** Value of the first attribute found along the given path, or null. */
function getPath(node: Element, path: string[], attrName: string): string {
    return getPathFrom(node, path, attrName);
}

function getPathFrom(node: Element, path: string[], attrName: string): string {
    let elements = selectPath(node, path);
    for (let i = 0; i < elements.length; i++) {
        let value = getAttr(elements[i], attrName);
        if (value != null) {
            return value;
        }
    }
    return null;
}

/** sum(s:RunTimeInformation/s:RunTimeCountersPerThread/@X) - empty node-set sums to 0. */
function sumCounter(node: Element, attrName: string): number {
    let counters = selectPath(node, ["RunTimeInformation", "RunTimeCountersPerThread"]);
    let sum = 0;
    for (let i = 0; i < counters.length; i++) {
        let value = getAttr(counters[i], attrName);
        if (value != null) {
            sum += toNumber(value);
        }
    }
    return sum;
}

/*
 * ================================
 * Number handling
 * ================================
 */

/**
 * Converts an attribute value to a number, accepting scientific notation
 * (the convertSciToNumString template). Missing values yield NaN like number('').
 */
function toNumber(value: string): number {
    if (value == null || /^\s*$/.test(value)) return NaN;
    return Number(value);
}

function isTruthyNumber(value: number): boolean {
    return value != 0 && !isNaN(value);
}

function divide(numerator: number, denominator: number): number {
    let result = numerator / denominator;
    return isFinite(result) ? result : 0;
}

/** format-number(round(x * 10^7) div 10^7, '0.#######') */
function formatRounded(value: number): string {
    if (isNaN(value)) return "NaN";
    let rounded = Math.round(value * 10000000) / 10000000;
    let text = rounded.toFixed(7);
    text = text.replace(/0+$/, "").replace(/\.$/, "");
    return text;
}

/** format-number(x, '0%') */
function formatPercent(value: number): string {
    if (isNaN(value)) return "NaN";
    return Math.round(value * 100) + "%";
}

/** XPath number to string conversion (integers without decimal point). */
function numberToString(value: number): string {
    return String(value);
}

function removeSpaces(value: string): string {
    return value.replace(/ /g, "");
}

export { renderPlan }
