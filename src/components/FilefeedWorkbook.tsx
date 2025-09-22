"use client";

import React, {
  useEffect,
  useState,
  useMemo,
  useRef,
  forwardRef,
  useImperativeHandle,
} from "react";
import {
  Container,
  Title,
  Text,
  Group,
  Button,
  Stack,
  LoadingOverlay,
  Card,
  Divider,
  Box,
  Flex,
  Table,
  ScrollArea,
} from "@mantine/core";
import { IconUpload, IconEdit } from "@tabler/icons-react";
import { IconTrash } from "@tabler/icons-react";
import { FilefeedSDKProps, FilefeedWorkbookRef, DataRow } from "../types";
import { useWorkbookStore } from "../stores/workbookStore";
import MappingInterface from "./MappingInterface";
import { Providers } from "../app/providers";
import { useManualEntry } from "../hooks/useManualEntry";
import { useDynamicRowCount } from "../hooks/useDynamicRowCount";
import { useFileImport } from "../hooks/useFileImport";
import { transformValue, validateField, validatePipelineConfig, mappingStateToFieldMappings } from "../utils/dataProcessing";

const FilefeedWorkbook = forwardRef<FilefeedWorkbookRef, FilefeedSDKProps>(
  ({ config, events, theme = "light", className }, ref) => {
    const [activeTab, setActiveTab] = useState<string>("import");
    const [isManualEntryMode, setIsManualEntryMode] = useState(false);
    const [reviewFilter, setReviewFilter] = useState<"all" | "valid" | "invalid">("all");
    const reviewViewportRef = useRef<HTMLDivElement | null>(null);
    const [reviewViewportHeight, setReviewViewportHeight] = useState<number>(600);
    const [reviewScrollTop, setReviewScrollTop] = useState<number>(0);

    const {
      setConfig,
      currentSheet,
      importedData,
      setImportedData,
      mappingState,
      updateMapping,
      processedData,
      isLoading,
      setLoading,
      pipelineMappings,
      setFieldMappings,
      transformRegistry,
      setProcessedRows,
      setMapping,
      clearImportedData,
      updateRowData,
      deleteRow,
      deleteInvalidRows,
      processOnContinue,
      reset: resetStore,
    } = useWorkbookStore();

    const currentSheetConfig = config.sheets?.find(
      (sheet) => sheet.slug === currentSheet
    );

    const {
      manualEntryData,
      manualEntryErrors,
      selectedFilter,
      setSelectedFilter,
      isCalculatingValidation,
      totalRows,
      validRows,
      invalidRows,
      isRowVisible,
      handleManualEntryChange,
      reset: resetManual,
    } = useManualEntry(currentSheetConfig?.fields);

    const { setContainerRef: setTableContainerRef, maxRows } =
      useDynamicRowCount();

    useEffect(() => {
      setConfig(config);
    }, [config, setConfig]);
    useEffect(() => {
      if (events?.onStepChange) {
        if (
          activeTab === "import" ||
          activeTab === "mapping" ||
          activeTab === "review"
        ) {
          events.onStepChange(activeTab);
        }
      }
    }, [activeTab, events]);

    useImperativeHandle(
      ref,
      () => ({
        reset: () => {
          resetStore();
          setConfig(config);
          setActiveTab("import");
          setIsManualEntryMode(false);
          resetManual();
          events?.onReset?.();
        },
      }),
      [config, resetStore, setConfig, events]
    );

    const { isUploading, triggerFilePicker } = useFileImport({
      currentSheet: currentSheet || "",
      pipelineMappings,
      config,
      onImported: (data) => {
        setImportedData(data);
        setActiveTab("mapping");
        // Exit manual mode if it was active and clear manual state
        if (isManualEntryMode) {
          setIsManualEntryMode(false);
          resetManual();
        }
        events?.onDataImported?.(data);
      },
      setProcessedRows,
      setLoading,
      setActiveTab,
    });

    const handleMappingChange = (mapping: any) => {
      Object.entries(mapping).forEach(([sourceColumn, targetField]) => {
        updateMapping(sourceColumn, targetField as string | null);
      });
      events?.onMappingChanged?.(mapping);
    };

    // Compute whether required mappings are satisfied and we can proceed
    const canProceedToReview = useMemo(() => {
      if (!currentSheetConfig) return false;
      const pipeline = pipelineMappings || {
        fieldMappings: mappingStateToFieldMappings(mappingState),
      };
      const availableTransforms = transformRegistry
        ? Object.keys(transformRegistry)
        : undefined;
      const cfgErrors = validatePipelineConfig(
        currentSheetConfig.fields,
        pipeline,
        availableTransforms
      );
      const missingRequired = cfgErrors.some((e) =>
        e.toLowerCase().includes("missing mapping for required field")
      );
      return !missingRequired;
    }, [currentSheetConfig, pipelineMappings, mappingState, transformRegistry]);

    // Reset store/UI to the initial import view
    const hardResetToImport = () => {
      resetStore();
      setConfig(config);
      setActiveTab("import");
      setIsManualEntryMode(false);
      resetManual();
      events?.onReset?.();
    };

    // Build processed rows from manual entry state (independent of file upload)
    const buildManualProcessedData = (): DataRow[] => {
      if (!currentSheetConfig) return [];
      // Keep order stable by sorting by original manual index
      const entries = Object.entries(manualEntryData)
        .map(([rowId, data]) => ({
          rowId,
          index: Number(rowId.replace(/^manual-/, "")) || 0,
          data,
        }))
        // include only rows that have some data entered
        .filter(({ data }) =>
          Object.values(data || {}).some((v) => String(v ?? "").trim() !== "")
        )
        .sort((a, b) => a.index - b.index);

      return entries.map(({ index, data }) => {
        const processed: Record<string, any> = {};
        const errors: any[] = [];
        currentSheetConfig.fields.forEach((field) => {
          const raw = (data as any)[field.key];
          const coerced = transformValue(raw, field.type);
          processed[field.key] = coerced;
          errors.push(...validateField(coerced, field, index));
        });
        return {
          id: `manual-row-${index}`,
          data: processed,
          errors,
          isValid: errors.filter((e) => e.severity === "error").length === 0,
        } as DataRow;
      });
    };

    const hasManualRows = totalRows > 0;

    const handleSubmit = () => {
      if (isManualEntryMode && hasManualRows) {
        const manualRows = buildManualProcessedData();
        events?.onWorkbookComplete?.(manualRows);
      } else {
        events?.onWorkbookComplete?.(processedData);
      }
    };

    // Compute review counts and visible rows for uploaded data review
    const allCount = processedData.length;
    const validCount = useMemo(
      () => processedData.filter((r) => r.isValid).length,
      [processedData]
    );
    const invalidCount = allCount - validCount;
    // Keep the currently edited row visible under the "Invalid" filter so it
    // doesn't disappear mid-typing when it becomes valid.
    const [editingRowId, setEditingRowId] = useState<string | null>(null);
    const unpinTimerRef = useRef<number | null>(null);
    const visibleProcessedRows = useMemo(() => {
      let rows = processedData as typeof processedData;
      if (reviewFilter === "valid") rows = processedData.filter((r) => r.isValid);
      else if (reviewFilter === "invalid") rows = processedData.filter((r) => !r.isValid);
      if (reviewFilter === "invalid" && editingRowId) {
        const editing = processedData.find((r) => r.id === editingRowId);
        if (editing && !rows.some((r) => r.id === editing.id)) {
          rows = [editing, ...rows];
        }
      }
      return rows;
    }, [processedData, reviewFilter, editingRowId]);

    // Virtualization for Review table
    const REVIEW_ROW_HEIGHT = 32; // px, includes borders
    useEffect(() => {
      const el = reviewViewportRef.current;
      if (!el) return;
      const measure = () => {
        setReviewViewportHeight(el.clientHeight || 600);
      };
      measure();
      const ro = new ResizeObserver(measure);
      ro.observe(el);
      return () => ro.disconnect();
    }, [reviewViewportRef]);

    const reviewVisibleCount = Math.ceil(reviewViewportHeight / REVIEW_ROW_HEIGHT) + 8; // overscan
    const reviewStartIndex = Math.max(0, Math.floor(reviewScrollTop / REVIEW_ROW_HEIGHT) - 4);
    const reviewEndIndex = Math.min(visibleProcessedRows.length, reviewStartIndex + reviewVisibleCount);
    const reviewPaddingTop = reviewStartIndex * REVIEW_ROW_HEIGHT;
    const reviewPaddingBottom = Math.max(0, (visibleProcessedRows.length - reviewEndIndex) * REVIEW_ROW_HEIGHT);
    const mappedFields = useMemo(
      () => Object.entries(mappingState).filter(([_, tgt]) => tgt).map(([_, tgt]) => String(tgt)),
      [mappingState]
    );

    return (
      <Providers>
        <div
          className={`filefeed-workbook ${className || ""}`}
          data-theme={theme}
        >
          <LoadingOverlay visible={isLoading} />

          <Container size="xl" py="xl">
            {activeTab === "mapping" && importedData && currentSheetConfig ? (
              <Card shadow="sm" padding={0} radius="md" withBorder>
                <MappingInterface
                  importedHeaders={importedData.headers}
                  fields={currentSheetConfig.fields}
                  mapping={mappingState}
                  onMappingChange={handleMappingChange}
                  importedData={importedData}
                  onBack={hardResetToImport}
                  onContinue={async () => {
                    await processOnContinue();
                    setActiveTab("review");
                  }}
                  onExit={hardResetToImport}
                  fieldMappings={pipelineMappings?.fieldMappings}
                  onFieldMappingsChange={setFieldMappings}
                  transformRegistry={transformRegistry}
                  isProcessing={isLoading}
                  canContinue={canProceedToReview}
                />
              </Card>
            ) : activeTab === "review" && importedData && currentSheetConfig ? (
              <Card shadow="sm" padding="md" radius="md" withBorder>
                <Group justify="space-between" align="center">
                  <Text size="sm" c="gray.8" fw={500}>
                    Review Mapped Data
                  </Text>
                  <Group gap="md">
                    <Button
                      size="xs"
                      variant="outline"
                      color="red"
                      onClick={() => deleteInvalidRows()}
                      disabled={invalidCount === 0}
                      styles={{
                        root: {
                          backgroundColor: "white",
                          borderColor: "var(--mantine-color-red-6)",
                          color: "var(--mantine-color-red-6)",
                          "&:hover": {
                            backgroundColor: "var(--mantine-color-red-0)",
                          },
                          "&:disabled": {
                            borderColor: "var(--mantine-color-gray-4)",
                            color: "var(--mantine-color-gray-6)",
                          },
                        },
                      }}
                    >
                      Delete all invalid
                    </Button>
                    <Button
                      variant="outline"
                      size="xs"
                      onClick={() => setActiveTab("mapping")}
                      styles={{
                        root: {
                          backgroundColor: "white",
                          borderColor: "black",
                          color: "black",
                          "&:hover": {
                            backgroundColor: "var(--mantine-color-gray-0)",
                          },
                        },
                      }}
                    >
                      Back to Mapping
                    </Button>
                    <Button
                      size="xs"
                      radius="md"
                      onClick={() => {
                        events?.onWorkbookComplete?.(processedData);
                      }}
                      styles={{
                        root: {
                          backgroundColor: "black",
                          color: "white",
                          border: "none",
                          "&:hover": {
                            backgroundColor: "#333",
                          },
                        },
                      }}
                    >
                      Submit {currentSheetConfig?.name} Data
                    </Button>
                    <div
                      style={{
                        display: "flex",
                        backgroundColor: "var(--mantine-color-gray-1)",
                        borderRadius: "6px",
                        padding: "2px",
                        gap: "2px",
                      }}
                    >
                      {[
                        { label: "All", value: "all", count: allCount },
                        { label: "Valid", value: "valid", count: validCount },
                        { label: "Invalid", value: "invalid", count: invalidCount },
                      ].map((item) => (
                        <button
                          key={item.value}
                          onClick={() => setReviewFilter(item.value as "all" | "valid" | "invalid")}
                          style={{
                            display: "flex",
                            alignItems: "center",
                            gap: "8px",
                            padding: "6px 12px",
                            borderRadius: "4px",
                            border: "none",
                            backgroundColor:
                              item.value === reviewFilter ? "white" : "transparent",
                            color: "var(--mantine-color-gray-7)",
                            fontSize: "13px",
                            fontWeight: 500,
                            cursor: "pointer",
                            transition: "all 0.15s ease",
                            boxShadow:
                              item.value === reviewFilter
                                ? "0 1px 2px rgba(0, 0, 0, 0.05)"
                                : "none",
                          }}
                        >
                          <span>{item.label}</span>
                          {item.count > 0 && (
                            <div
                              style={{
                                display: "flex",
                                alignItems: "center",
                                justifyContent: "center",
                                minWidth: "20px",
                                height: "20px",
                                borderRadius: "10px",
                                backgroundColor: "var(--mantine-color-gray-4)",
                                color: "white",
                                fontSize: "11px",
                                fontWeight: 600,
                              }}
                            >
                              {item.count}
                            </div>
                          )}
                        </button>
                      ))}
                    </div>
                  </Group>
                </Group>

                <Divider my="md" />

                <div
                  ref={reviewViewportRef}
                  onScroll={(e) => setReviewScrollTop((e.currentTarget as HTMLDivElement).scrollTop)}
                  style={{ height: 600, overflowY: "auto" }}
                >
                  <Table
                    striped={false}
                    highlightOnHover={true}
                    withTableBorder
                    withColumnBorders
                    style={{
                      backgroundColor: "white",
                      borderCollapse: "collapse",
                      width: "100%",
                    }}
                  >
                    <Table.Thead>
                      <Table.Tr
                        style={{
                          backgroundColor: "var(--mantine-color-gray-0)",
                        }}
                      >
                        {Object.entries(mappingState)
                          .filter(([_, targetField]) => targetField)
                          .map(([_, targetField]) => {
                            const field = currentSheetConfig.fields.find(
                              (f) => f.key === targetField
                            );
                            return (
                              <Table.Th
                                key={targetField}
                                style={{
                                  color: "var(--mantine-color-gray-8)",
                                  fontWeight: 500,
                                  fontSize: "12px",
                                  borderBottom:
                                    "1px solid var(--mantine-color-gray-3)",
                                  borderRight:
                                    "1px solid var(--mantine-color-gray-3)",
                                  backgroundColor:
                                    "var(--mantine-color-gray-0)",
                                  padding: "6px 10px",
                                  minWidth: "120px",
                                  position: "sticky",
                                  top: 0,
                                  zIndex: 1,
                                }}
                              >
                                {field?.label || targetField}
                              </Table.Th>
                            );
                          })}
                        <Table.Th
                          key="__actions__"
                          style={{
                            color: "var(--mantine-color-gray-8)",
                            fontWeight: 500,
                            fontSize: "12px",
                            borderBottom: "1px solid var(--mantine-color-gray-3)",
                            backgroundColor: "var(--mantine-color-gray-0)",
                            padding: "6px 10px",
                            position: "sticky",
                            top: 0,
                            zIndex: 1,
                            width: 80,
                          }}
                        >
                          Actions
                        </Table.Th>
                      </Table.Tr>
                    </Table.Thead>
                    <Table.Tbody>
                      {/* Top spacer row */}
                      {reviewPaddingTop > 0 && (
                        <Table.Tr>
                          <Table.Td
                            colSpan={Math.max(1, mappedFields.length) + 1}
                            style={{ height: reviewPaddingTop, padding: 0, border: "none", background: "transparent" }}
                          />
                        </Table.Tr>
                      )}
                      {visibleProcessedRows.slice(reviewStartIndex, reviewEndIndex).map((pRow, index) => (
                        <Table.Tr key={pRow.id || index}>
                          {mappedFields.map((targetField) => {
                              const field = currentSheetConfig.fields.find(
                                (f) => f.key === targetField
                              );
                              const value = (pRow.data || {})[targetField] ?? "";
                              const fieldHasError = (pRow.errors || []).some(
                                (e) => e.field === targetField
                              );
                              const firstError = (pRow.errors || []).find(
                                (e) => e.field === targetField
                              );
                              return (
                                <Table.Td
                                  key={`${pRow.id}-${targetField}`}
                                  style={{
                                    borderBottom:
                                      "1px solid var(--mantine-color-gray-3)",
                                    borderRight:
                                      "1px solid var(--mantine-color-gray-3)",
                                    padding: 0,
                                    backgroundColor: fieldHasError
                                      ? "var(--mantine-color-red-0)"
                                      : "white",
                                  }}
                                >
                                  <input
                                    type={field?.type === "number" ? "number" : "text"}
                                    value={String(value)}
                                    onChange={(e) =>
                                      updateRowData(pRow.id, targetField, e.target.value)
                                    }
                                    onFocus={() => {
                                      if (unpinTimerRef.current) {
                                        window.clearTimeout(unpinTimerRef.current);
                                        unpinTimerRef.current = null;
                                      }
                                      setEditingRowId(pRow.id);
                                    }}
                                    onBlur={() => {
                                      // small delay to allow focus to move within the same row
                                      if (unpinTimerRef.current) {
                                        window.clearTimeout(unpinTimerRef.current);
                                      }
                                      unpinTimerRef.current = window.setTimeout(() => {
                                        setEditingRowId((curr) => (curr === pRow.id ? null : curr));
                                        unpinTimerRef.current = null;
                                      }, 120);
                                    }}
                                    title={firstError?.message}
                                    style={{
                                      width: "100%",
                                      height: `${REVIEW_ROW_HEIGHT - 2}px`,
                                      border: fieldHasError
                                        ? "1px solid var(--mantine-color-red-5)"
                                        : "1px solid transparent",
                                      outline: "none",
                                      padding: "6px 10px",
                                      fontSize: "12px",
                                      backgroundColor: "transparent",
                                      color: "var(--mantine-color-gray-8)",
                                      boxSizing: "border-box",
                                    }}
                                  />
                                </Table.Td>
                              );
                            })}
                          {/* Actions column */}
                          <Table.Td
                            key={`${pRow.id}-__actions__`}
                            style={{
                              borderBottom: "1px solid var(--mantine-color-gray-3)",
                              padding: 0,
                              backgroundColor: "white",
                              textAlign: "center",
                              width: 80,
                            }}
                          >
                            <Button
                              size="compact-xs"
                              variant="subtle"
                              color="red"
                              onClick={() => deleteRow(pRow.id)}
                              leftSection={<IconTrash size={14} />}
                              styles={{
                                root: {
                                  height: `${REVIEW_ROW_HEIGHT - 6}px`,
                                  paddingLeft: 8,
                                  paddingRight: 8,
                                },
                              }}
                            >
                              Delete
                            </Button>
                          </Table.Td>
                        </Table.Tr>
                      ))}
                      {/* Bottom spacer row */}
                      {reviewPaddingBottom > 0 && (
                        <Table.Tr>
                          <Table.Td
                            colSpan={Math.max(1, mappedFields.length) + 1}
                            style={{ height: reviewPaddingBottom, padding: 0, border: "none", background: "transparent" }}
                          />
                        </Table.Tr>
                      )}
                    </Table.Tbody>
                  </Table>
                </div>
              </Card>
            ) : (
              <Card shadow="sm" padding="md" radius="md" withBorder>
                <Group justify="space-between" align="center">
                  <Text size="sm" c="gray.8" fw={500}>
                    {currentSheetConfig?.name || "Data Sheet"}
                  </Text>
                  <Group gap="md">
                    {isManualEntryMode && (
                      <Button
                        size="xs"
                        variant="outline"
                        color="dark"
                        onClick={hardResetToImport}
                        styles={{
                          root: {
                            backgroundColor: "white",
                            borderColor: "gray",
                            color: "black",
                            fontSize: "12px",
                            "&:hover": {
                              backgroundColor: "var(--mantine-color-gray-0)",
                            },
                          },
                        }}
                      >
                        Back
                      </Button>
                    )}
                    {(isManualEntryMode || Object.keys(mappingState).length > 0) && (
                      <Button
                        size="xs"
                        radius="md"
                        onClick={handleSubmit}
                        disabled={isManualEntryMode && !hasManualRows}
                        styles={{
                          root: {
                            backgroundColor: "black",
                            color: "white",
                            border: "none",
                            "&:hover": {
                              backgroundColor: "#333",
                            },
                            "&:disabled": {
                              backgroundColor: "var(--mantine-color-gray-4)",
                              color: "var(--mantine-color-gray-6)",
                              border: "none",
                              cursor: "not-allowed",
                            },
                          },
                        }}
                      >
                        Submit {currentSheetConfig?.name} Data
                      </Button>
                    )}
                    <div
                      style={{
                        display: "flex",
                        backgroundColor: "var(--mantine-color-gray-1)",
                        borderRadius: "6px",
                        padding: "2px",
                        gap: "2px",
                      }}
                    >
                      {[
                        { label: "All", value: "all", count: totalRows },
                        { label: "Valid", value: "valid", count: validRows },
                        {
                          label: "Invalid",
                          value: "invalid",
                          count: invalidRows,
                        },
                      ].map((item) => (
                        <button
                          key={item.value}
                          onClick={() =>
                            setSelectedFilter(
                              item.value as "all" | "valid" | "invalid"
                            )
                          }
                          style={{
                            display: "flex",
                            alignItems: "center",
                            gap: "8px",
                            padding: "6px 12px",
                            borderRadius: "4px",
                            border: "none",
                            backgroundColor:
                              item.value === selectedFilter
                                ? "white"
                                : "transparent",
                            color: "var(--mantine-color-gray-7)",
                            fontSize: "13px",
                            fontWeight: 500,
                            cursor: "pointer",
                            transition: "all 0.15s ease",
                            boxShadow:
                              item.value === selectedFilter
                                ? "0 1px 2px rgba(0, 0, 0, 0.05)"
                                : "none",
                          }}
                          onMouseEnter={(e) => {
                            if (item.value !== selectedFilter) {
                              e.currentTarget.style.backgroundColor =
                                "rgba(255, 255, 255, 0.5)";
                            }
                          }}
                          onMouseLeave={(e) => {
                            if (item.value !== selectedFilter) {
                              e.currentTarget.style.backgroundColor =
                                "transparent";
                            }
                          }}
                        >
                          <span>{item.label}</span>
                          {(item.count > 0 || isCalculatingValidation) && (
                            <div
                              style={{
                                display: "flex",
                                alignItems: "center",
                                justifyContent: "center",
                                minWidth: "20px",
                                height: "20px",
                                borderRadius: "10px",
                                backgroundColor: "var(--mantine-color-gray-4)",
                                color: "white",
                                fontSize: "11px",
                                fontWeight: 600,
                              }}
                            >
                              {isCalculatingValidation ? (
                                <div
                                  style={{
                                    width: "10px",
                                    height: "10px",
                                    border: "2px solid white",
                                    borderTop: "2px solid transparent",
                                    borderRadius: "50%",
                                    animation: "spin 1s linear infinite",
                                  }}
                                />
                              ) : (
                                item.count
                              )}
                            </div>
                          )}
                        </button>
                      ))}
                    </div>
                    <style>{`
                  @keyframes spin {
                    0% { transform: rotate(0deg); }
                    100% { transform: rotate(360deg); }
                  }
                `}</style>
                  </Group>
                </Group>

                <Divider my="md" />

                <Box
                  style={{
                    position: "relative",
                    minHeight: "600px",
                    overflow: "hidden",
                  }}
                >
                  <Box
                    style={{
                      position: "absolute",
                      inset: 0,
                      zIndex: 1,
                      padding: "16px",
                    }}
                  >
                    <div
                      ref={setTableContainerRef}
                      style={{
                        height: "100%",
                        minHeight: "400px",
                        overflow: "hidden",
                      }}
                    >
                      {currentSheetConfig && (
                        <Table
                          striped={false}
                          highlightOnHover={false}
                          withTableBorder
                          withColumnBorders
                          style={{
                            height: "100%",
                            opacity: isManualEntryMode ? 1 : 0.98,
                            filter: isManualEntryMode ? "none" : "blur(0.5px)",
                            pointerEvents: isManualEntryMode ? "auto" : "none",
                            backgroundColor: "white",
                            borderCollapse: "collapse",
                            tableLayout: "fixed",
                            width: "100%",
                          }}
                        >
                          <Table.Thead>
                            <Table.Tr
                              style={{
                                backgroundColor: "var(--mantine-color-gray-0)",
                              }}
                            >
                              {currentSheetConfig.fields.map((field) => (
                                <Table.Th
                                  key={field.key}
                                  style={{
                                    color: isManualEntryMode
                                      ? "var(--mantine-color-gray-8)"
                                      : "var(--mantine-color-gray-5)",
                                    fontWeight: 500,
                                    fontSize: "12px",
                                    height: "24px",
                                    borderBottom:
                                      "1px solid var(--mantine-color-gray-3)",
                                    borderRight:
                                      "1px solid var(--mantine-color-gray-3)",
                                    backgroundColor:
                                      "var(--mantine-color-gray-0)",
                                    padding: "6px 10px",
                                    width: `${
                                      100 / currentSheetConfig.fields.length
                                    }%`,
                                    minWidth: "120px",
                                    maxWidth: `${
                                      100 / currentSheetConfig.fields.length
                                    }%`,
                                  }}
                                >
                                  {field.label}
                                </Table.Th>
                              ))}
                            </Table.Tr>
                          </Table.Thead>
                          <Table.Tbody>
                            {(() => {
                              const visibleDataRows = Array.from(
                                { length: maxRows },
                                (_, i) => i
                              ).filter(isRowVisible);
                              const totalRows = [];

                              visibleDataRows.forEach((originalIndex) => {
                                totalRows.push({ type: "data", originalIndex });
                              });

                              const blanksNeeded =
                                maxRows - visibleDataRows.length;
                              for (let i = 0; i < blanksNeeded; i++) {
                                totalRows.push({
                                  type: "blank",
                                  originalIndex: maxRows + i,
                                });
                              }

                              return totalRows.map((row, displayIndex) => (
                                <Table.Tr
                                  key={
                                    row.type === "data"
                                      ? `data-${row.originalIndex}`
                                      : `blank-${row.originalIndex}`
                                  }
                                  style={{ backgroundColor: "white" }}
                                >
                                  {currentSheetConfig.fields.map((field) => {
                                    const isDataRow = row.type === "data";
                                    const rowIndex = isDataRow
                                      ? row.originalIndex
                                      : row.originalIndex;

                                    return (
                                      <Table.Td
                                        key={field.key}
                                        style={{
                                          color: "var(--mantine-color-gray-5)",
                                          fontSize: "12px",
                                          padding: "0",
                                          borderRight:
                                            "1px solid var(--mantine-color-gray-3)",
                                          borderBottom:
                                            displayIndex ===
                                            totalRows.length - 1
                                              ? "2px solid var(--mantine-color-gray-3)"
                                              : "1px solid var(--mantine-color-gray-3)",
                                          backgroundColor: "white",
                                          minHeight: "24px",
                                          width: `${
                                            100 /
                                            currentSheetConfig.fields.length
                                          }%`,
                                          minWidth: "120px",
                                          maxWidth: `${
                                            100 /
                                            currentSheetConfig.fields.length
                                          }%`,
                                          overflow: "hidden",
                                        }}
                                      >
                                        {isManualEntryMode ? (
                                          <input
                                            type={
                                              field.type === "number"
                                                ? "number"
                                                : "text"
                                            }
                                            value={
                                              isDataRow
                                                ? manualEntryData[
                                                    `manual-${row.originalIndex}`
                                                  ]?.[field.key] || ""
                                                : ""
                                            }
                                            onChange={(e) => {
                                              if (isDataRow) {
                                                handleManualEntryChange(
                                                  row.originalIndex,
                                                  field.key,
                                                  e.target.value
                                                );
                                              } else {
                                                handleManualEntryChange(
                                                  rowIndex,
                                                  field.key,
                                                  e.target.value
                                                );
                                              }
                                            }}
                                            style={{
                                              width: "100%",
                                              height: "24px",
                                              minHeight: "24px",
                                              maxHeight: "24px",
                                              border:
                                                isDataRow &&
                                                manualEntryErrors[
                                                  `manual-${row.originalIndex}`
                                                ]?.[field.key]
                                                  ? "1px solid var(--mantine-color-red-5)"
                                                  : "1px solid transparent",
                                              outline: "none",
                                              padding: "6px 10px",
                                              fontSize: "12px",
                                              backgroundColor:
                                                isDataRow &&
                                                manualEntryErrors[
                                                  `manual-${row.originalIndex}`
                                                ]?.[field.key]
                                                  ? "var(--mantine-color-red-0)"
                                                  : "transparent",
                                              color:
                                                "var(--mantine-color-gray-8)",
                                              boxSizing: "border-box",
                                              minWidth: 0,
                                              borderRadius: "0px",
                                              transition:
                                                "border-color 0.1s ease, background-color 0.1s ease",
                                            }}
                                            onFocus={(e) => {
                                              const errorKey = isDataRow
                                                ? `manual-${row.originalIndex}`
                                                : `manual-${rowIndex}`;
                                              if (
                                                !manualEntryErrors[errorKey]?.[
                                                  field.key
                                                ]
                                              ) {
                                                e.target.style.border =
                                                  "1px solid black";
                                                e.target.style.borderRadius =
                                                  "2px";
                                              }
                                            }}
                                            onBlur={(e) => {
                                              const errorKey = isDataRow
                                                ? `manual-${row.originalIndex}`
                                                : `manual-${rowIndex}`;
                                              if (
                                                !manualEntryErrors[errorKey]?.[
                                                  field.key
                                                ]
                                              ) {
                                                e.target.style.border =
                                                  "1px solid transparent";
                                                e.target.style.borderRadius =
                                                  "0px";
                                              }
                                            }}
                                            title={
                                              (isDataRow &&
                                                manualEntryErrors[
                                                  `manual-${row.originalIndex}`
                                                ]?.[field.key]) ||
                                              undefined
                                            }
                                          />
                                        ) : (
                                          <div
                                            style={{
                                              padding: "6px 10px",
                                              height: "24px",
                                              minHeight: "24px",
                                              boxSizing: "border-box",
                                              display: "flex",
                                              alignItems: "center",
                                            }}
                                          ></div>
                                        )}
                                      </Table.Td>
                                    );
                                  })}
                                </Table.Tr>
                              ));
                            })()}
                          </Table.Tbody>
                        </Table>
                      )}
                    </div>
                  </Box>

                  {!isManualEntryMode && (
                    <Flex
                      align="center"
                      justify="center"
                      direction="column"
                      style={{
                        position: "absolute",
                        inset: 0,
                        zIndex: 3,
                        backgroundColor: "rgba(255, 255, 255, 0.02)",
                        backdropFilter: "none",
                      }}
                    >
                      <Stack align="center" gap="sm">
                        <div style={{ textAlign: "center" }}>
                          <Title order={2} size="sm" fw={600} c="gray.8">
                            Drag and drop or upload a file to get started
                          </Title>
                        </div>

                        <Stack gap="md" align="center">
                          <Button
                            size="xs"
                            variant="outline"
                            color="dark"
                            leftSection={<IconUpload size={15} />}
                            loading={isUploading}
                            onClick={triggerFilePicker}
                            styles={{
                              root: {
                                backgroundColor: "white",
                                borderColor: "gray",
                                color: "black",
                                fontSize: "12px",
                                "&:hover": {
                                  backgroundColor:
                                    "var(--mantine-color-gray-0)",
                                },
                              },
                            }}
                          >
                            Upload file
                          </Button>

                          <Button
                            size="xs"
                            variant="outline"
                            color="dark"
                            leftSection={<IconEdit size={15} />}
                            onClick={() => {
                              // Enter manual entry mode and clear any previous import state
                              setIsManualEntryMode(true);
                              clearImportedData();
                              setMapping({});
                            }}
                            styles={{
                              root: {
                                backgroundColor: "white",
                                borderColor: "gray",
                                color: "black",
                                fontSize: "12px",
                                "&:hover": {
                                  backgroundColor:
                                    "var(--mantine-color-gray-0)",
                                },
                              },
                            }}
                          >
                            Manually enter data
                          </Button>
                        </Stack>
                      </Stack>
                    </Flex>
                  )}
                </Box>
              </Card>
            )}
          </Container>
        </div>
      </Providers>
    );
  }
);

export default FilefeedWorkbook;
FilefeedWorkbook.displayName = "FilefeedWorkbook";
